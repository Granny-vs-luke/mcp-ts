import { StorageBackend, SessionData, SetClientOptions } from './types.js';
import { generateSessionId } from '../../shared/utils.js';

/**
 * In-memory implementation of StorageBackend
 * Useful for local development or testing
 */
export class MemoryStorageBackend implements StorageBackend {
    // Map<userId:sessionId, SessionData>
    private sessions = new Map<string, SessionData>();

    // Map<userId, Set<sessionId>>
    private userIdSessions = new Map<string, Set<string>>();

    constructor() { }

    async init(): Promise<void> {
        console.log('[mcp-ts][Storage] Memory: ✓ internal memory store active.');
    }

    private getSessionKey(userId: string, sessionId: string): string {
        return `${userId}:${sessionId}`;
    }

    generateSessionId(): string {
        return generateSessionId();
    }

    async createSession(session: SessionData, ttl?: number): Promise<void> {
        const { sessionId, userId } = session;
        if (!sessionId || !userId) throw new Error('userId and sessionId required');

        const sessionKey = this.getSessionKey(userId, sessionId);
        if (this.sessions.has(sessionKey)) {
            throw new Error(`Session ${sessionId} already exists`);
        }

        this.sessions.set(sessionKey, session);

        // Update index
        if (!this.userIdSessions.has(userId)) {
            this.userIdSessions.set(userId, new Set());
        }
        this.userIdSessions.get(userId)!.add(sessionId);
        // Note: TTL is ignored in memory backend - sessions don't auto-expire
    }

    async updateSession(userId: string, sessionId: string, data: Partial<SessionData>, ttl?: number): Promise<void> {
        if (!userId || !sessionId) throw new Error('userId and sessionId required');

        const sessionKey = this.getSessionKey(userId, sessionId);
        const current = this.sessions.get(sessionKey);

        if (!current) {
            throw new Error(`Session ${sessionId} not found`);
        }

        const updated = {
            ...current,
            ...data
        };

        this.sessions.set(sessionKey, updated);
        // Note: TTL is ignored in memory backend - sessions don't auto-expire
    }


    async getSession(userId: string, sessionId: string): Promise<SessionData | null> {
        const sessionKey = this.getSessionKey(userId, sessionId);
        return this.sessions.get(sessionKey) || null;
    }

    async listSessionIds(userId: string): Promise<string[]> {
        const set = this.userIdSessions.get(userId);
        return set ? Array.from(set) : [];
    }

    async listSessions(userId: string): Promise<SessionData[]> {
        const set = this.userIdSessions.get(userId);
        if (!set) return [];

        const results: SessionData[] = [];
        for (const sessionId of set) {
            const session = this.sessions.get(this.getSessionKey(userId, sessionId));
            if (session) {
                results.push(session);
            }
        }
        return results;
    }

    async deleteSession(userId: string, sessionId: string): Promise<void> {
        const sessionKey = this.getSessionKey(userId, sessionId);
        this.sessions.delete(sessionKey);

        const set = this.userIdSessions.get(userId);
        if (set) {
            set.delete(sessionId);
            if (set.size === 0) {
                this.userIdSessions.delete(userId);
            }
        }
    }

    async listGlobalSessionIds(): Promise<string[]> {
        return Array.from(this.sessions.values()).map(s => s.sessionId);
    }

    async clearGlobalSessions(): Promise<void> {
        this.sessions.clear();
        this.userIdSessions.clear();
    }

    async cleanupExpiredSessions(): Promise<void> {
        // In-memory doesn't implement TTL automatically, 
        // but we could check createdAt + TTL here if needed.
        // For now, no-op.
    }

    async disconnect(): Promise<void> {
        // No-op for memory
    }
}
