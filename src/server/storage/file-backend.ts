import { promises as fs } from 'fs';
import * as path from 'path';
import type { SessionStore, Session, SessionCredentials } from './types.js';
import { generateSessionId } from '../../shared/utils.js';
import {
    mergeSessionUpdate,
    normalizeNewSession,
    normalizeStoredSession,
    isSessionExpired,
} from './lifecycle.js';

/**
 * File system implementation of SessionStore
 * Persists sessions to a JSON file
 */
export class FileStorageBackend implements SessionStore {
    private filePath: string;
    private memoryCache: Map<string, Session> | null = null;
    private credentialsCache: Map<string, SessionCredentials> | null = null;
    private initialized = false;

    /**
     * @param options.path Path to the JSON file storage (default: ./sessions.json)
     */
    constructor(options: { path?: string } = {}) {
        this.filePath = options.path || './sessions.json';
    }

    /**
     * Initialize storage: ensure file exists and load into memory cache
     */
    async init(): Promise<void> {
        if (this.initialized) return;

        try {
            // Ensure directory exists
            const dir = path.dirname(this.filePath);
            await fs.mkdir(dir, { recursive: true });

            // Try to read file
            const data = await fs.readFile(this.filePath, 'utf-8');
            const json = JSON.parse(data);

            this.memoryCache = new Map();
            this.credentialsCache = new Map();
            if (Array.isArray(json.sessions)) {
                json.sessions.forEach((s: Session) => {
                    const session = normalizeStoredSession(s);
                    this.memoryCache!.set(this.getSessionKey(session.userId || 'unknown', session.sessionId), session);
                });
            }
            if (Array.isArray(json.credentials)) {
                json.credentials.forEach((c: SessionCredentials) => {
                    this.credentialsCache!.set(this.getSessionKey(c.userId, c.sessionId), c);
                });
            }
        } catch (error: any) {
            if (error.code === 'ENOENT') {
                // File does not exist, initialize empty
                this.memoryCache = new Map();
                this.credentialsCache = new Map();
                await this.flush();
            } else {
                console.error('[FileStorage] Failed to load sessions:', error);
                throw error;
            }
        }

        this.initialized = true;
        console.log(`[mcp-ts][Storage] File: ✓ storage directory at ${path.dirname(this.filePath)} verified.`);
    }

    private async ensureInitialized() {
        if (!this.initialized) await this.init();
    }

    private async flush(): Promise<void> {
        if (!this.memoryCache || !this.credentialsCache) return;
        await fs.writeFile(this.filePath, JSON.stringify({
            sessions: Array.from(this.memoryCache.values()),
            credentials: Array.from(this.credentialsCache.values()),
        }, null, 2), 'utf-8');
    }

    private getSessionKey(userId: string, sessionId: string): string {
        return `${userId}:${sessionId}`;
    }

    generateSessionId(): string {
        return generateSessionId();
    }

    async create(session: Session): Promise<void> {
        await this.ensureInitialized();
        const { sessionId, userId } = session;
        if (!sessionId || !userId) throw new Error('userId and sessionId required');

        const sessionKey = this.getSessionKey(userId, sessionId);
        if (this.memoryCache!.has(sessionKey)) {
            throw new Error(`Session ${sessionId} already exists`);
        }

        this.memoryCache!.set(sessionKey, normalizeNewSession(session));
        await this.flush();
    }

    async update(userId: string, sessionId: string, data: Partial<Session>): Promise<void> {
        await this.ensureInitialized();
        if (!userId || !sessionId) throw new Error('userId and sessionId required');

        const sessionKey = this.getSessionKey(userId, sessionId);
        const current = this.memoryCache!.get(sessionKey);

        if (!current) {
            throw new Error(`Session ${sessionId} not found`);
        }

        const updated = mergeSessionUpdate(current, data);

        this.memoryCache!.set(sessionKey, updated);
        await this.flush();
    }

    async patchCredentials(userId: string, sessionId: string, data: Partial<SessionCredentials>): Promise<void> {
        await this.ensureInitialized();
        const sessionKey = this.getSessionKey(userId, sessionId);
        if (!this.memoryCache!.has(sessionKey)) {
            throw new Error(`Session ${sessionId} not found`);
        }

        const current = this.credentialsCache!.get(sessionKey) ?? { sessionId, userId };
        this.credentialsCache!.set(sessionKey, { ...current, ...data, sessionId, userId });
        await this.flush();
    }

    async get(userId: string, sessionId: string): Promise<Session | null> {
        await this.ensureInitialized();
        const sessionKey = this.getSessionKey(userId, sessionId);
        return this.memoryCache!.get(sessionKey) || null;
    }

    async getCredentials(userId: string, sessionId: string): Promise<SessionCredentials | null> {
        await this.ensureInitialized();
        const sessionKey = this.getSessionKey(userId, sessionId);
        if (!this.memoryCache!.has(sessionKey)) return null;
        return this.credentialsCache!.get(sessionKey) ?? { sessionId, userId };
    }

    async clearCredentials(userId: string, sessionId: string): Promise<void> {
        await this.patchCredentials(userId, sessionId, {
            clientInformation: null,
            tokens: null,
            codeVerifier: null,
            clientId: null,
            oauthState: null,
        });
    }

    async list(userId: string): Promise<Session[]> {
        await this.ensureInitialized();
        return Array.from(this.memoryCache!.values()).filter(s => s.userId === userId);
    }

    async listIds(userId: string): Promise<string[]> {
        await this.ensureInitialized();
        return Array.from(this.memoryCache!.values())
            .filter(s => s.userId === userId)
            .map(s => s.sessionId);
    }

    async delete(userId: string, sessionId: string): Promise<void> {
        await this.ensureInitialized();
        const sessionKey = this.getSessionKey(userId, sessionId);
        const deleted = this.memoryCache!.delete(sessionKey);
        this.credentialsCache!.delete(sessionKey);
        if (deleted) {
            await this.flush();
        }
    }

    async listAllIds(): Promise<string[]> {
        await this.ensureInitialized();
        return Array.from(this.memoryCache!.values()).map(s => s.sessionId);
    }

    async clearAll(): Promise<void> {
        await this.ensureInitialized();
        this.memoryCache!.clear();
        this.credentialsCache!.clear();
        await this.flush();
    }

    async cleanupExpired(): Promise<void> {
        await this.ensureInitialized();
        let changed = false;

        for (const [key, session] of this.memoryCache!.entries()) {
            if (!isSessionExpired(session)) continue;

            this.memoryCache!.delete(key);
            this.credentialsCache!.delete(key);
            changed = true;
        }

        if (changed) {
            await this.flush();
        }
    }

    async disconnect(): Promise<void> {
        // No explicit disconnect needed for file
    }
}
