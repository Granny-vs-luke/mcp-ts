import { promises as fs } from 'fs';
import * as path from 'path';
import type { SessionStore, Session, SetClientOptions } from './types.js';
import { generateSessionId } from '../../shared/utils.js';

/**
 * File system implementation of SessionStore
 * Persists sessions to a JSON file
 */
export class FileStorageBackend implements SessionStore {
    private filePath: string;
    private memoryCache: Map<string, Session> | null = null;
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
                json.forEach((s: Session) => {
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

    async create(session: Session, ttl?: number): Promise<void> {
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

    async update(userId: string, sessionId: string, data: Partial<Session>, ttl?: number): Promise<void> {
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

    async get(userId: string, sessionId: string): Promise<Session | null> {
        await this.ensureInitialized();
        const sessionKey = this.getSessionKey(userId, sessionId);
        return this.memoryCache!.get(sessionKey) || null;
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
        if (this.memoryCache!.delete(sessionKey)) {
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
        await this.flush();
    }

    async cleanupExpired(): Promise<void> {
        // Could implement TTL check here using createdAt
        await this.ensureInitialized();
    }

    async disconnect(): Promise<void> {
        // No explicit disconnect needed for file
    }
}
