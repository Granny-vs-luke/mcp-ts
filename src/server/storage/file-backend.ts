import { promises as fs } from 'fs';
import * as path from 'path';
import { StorageBackend, SessionData, SetClientOptions } from './types.js';
import { generateSessionId } from '../../shared/utils.js';

/**
 * File system implementation of StorageBackend
 * Persists sessions to a JSON file
 */
export class FileStorageBackend implements StorageBackend {
    private filePath: string;
    private memoryCache: Map<string, SessionData> | null = null;
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
            if (Array.isArray(json)) {
                json.forEach((s: SessionData) => {
                    this.memoryCache!.set(this.getSessionKey(s.userId || 'unknown', s.sessionId), s);
                });
            }
        } catch (error: any) {
            if (error.code === 'ENOENT') {
                // File does not exist, initialize empty
                this.memoryCache = new Map();
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
        if (!this.memoryCache) return;
        const sessions = Array.from(this.memoryCache.values());
        await fs.writeFile(this.filePath, JSON.stringify(sessions, null, 2), 'utf-8');
    }

    private getSessionKey(userId: string, sessionId: string): string {
        return `${userId}:${sessionId}`;
    }

    generateSessionId(): string {
        return generateSessionId();
    }

    async createSession(session: SessionData, ttl?: number): Promise<void> {
        await this.ensureInitialized();
        const { sessionId, userId } = session;
        if (!sessionId || !userId) throw new Error('userId and sessionId required');

        const sessionKey = this.getSessionKey(userId, sessionId);
        if (this.memoryCache!.has(sessionKey)) {
            throw new Error(`Session ${sessionId} already exists`);
        }

        this.memoryCache!.set(sessionKey, session);
        await this.flush();
        // Note: TTL is ignored in file backend - sessions don't auto-expire
    }

    async updateSession(userId: string, sessionId: string, data: Partial<SessionData>, ttl?: number): Promise<void> {
        await this.ensureInitialized();
        if (!userId || !sessionId) throw new Error('userId and sessionId required');

        const sessionKey = this.getSessionKey(userId, sessionId);
        const current = this.memoryCache!.get(sessionKey);

        if (!current) {
            throw new Error(`Session ${sessionId} not found`);
        }

        const updated = {
            ...current,
            ...data
        };

        this.memoryCache!.set(sessionKey, updated);
        await this.flush();
        // Note: TTL is ignored in file backend - sessions don't auto-expire
    }

    async getSession(userId: string, sessionId: string): Promise<SessionData | null> {
        await this.ensureInitialized();
        const sessionKey = this.getSessionKey(userId, sessionId);
        return this.memoryCache!.get(sessionKey) || null;
    }

    async listSessions(userId: string): Promise<SessionData[]> {
        await this.ensureInitialized();
        return Array.from(this.memoryCache!.values()).filter(s => s.userId === userId);
    }

    async listSessionIds(userId: string): Promise<string[]> {
        await this.ensureInitialized();
        return Array.from(this.memoryCache!.values())
            .filter(s => s.userId === userId)
            .map(s => s.sessionId);
    }

    async deleteSession(userId: string, sessionId: string): Promise<void> {
        await this.ensureInitialized();
        const sessionKey = this.getSessionKey(userId, sessionId);
        if (this.memoryCache!.delete(sessionKey)) {
            await this.flush();
        }
    }

    async listGlobalSessionIds(): Promise<string[]> {
        await this.ensureInitialized();
        return Array.from(this.memoryCache!.values()).map(s => s.sessionId);
    }

    async clearGlobalSessions(): Promise<void> {
        await this.ensureInitialized();
        this.memoryCache!.clear();
        await this.flush();
    }

    async cleanupExpiredSessions(): Promise<void> {
        // Could implement TTL check here using createdAt
        await this.ensureInitialized();
    }

    async disconnect(): Promise<void> {
        // No explicit disconnect needed for file
    }
}
