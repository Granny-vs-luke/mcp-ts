
import type { Redis } from 'ioredis';
import { customAlphabet } from 'nanoid';
import { StorageBackend, SessionData } from './types';
import { SESSION_TTL_SECONDS } from '../../shared/constants.js';

/** first char: letters only (required by OpenAI) */
const firstChar = customAlphabet(
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz',
    1
);

/** remaining chars: alphanumeric */
const rest = customAlphabet(
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
    11
);

/**
 * Redis implementation of StorageBackend
 */
export class RedisStorageBackend implements StorageBackend {
    private readonly DEFAULT_TTL = SESSION_TTL_SECONDS;
    private readonly KEY_PREFIX = 'mcp:session:';
    private readonly IDENTITY_KEY_PREFIX = 'mcp:identity:';
    private readonly IDENTITY_KEY_SUFFIX = ':sessions';

    constructor(private redis: Redis) { }

    /**
     * Generates Redis key for a specific session
     * @private
     */
    private getSessionKey(identity: string, sessionId: string): string {
        return `${this.KEY_PREFIX}${identity}:${sessionId}`;
    }

    /**
     * Generates Redis key for tracking all sessions for an identity
     * @private
     */
    private getIdentityKey(identity: string): string {
        return `${this.IDENTITY_KEY_PREFIX}${identity}${this.IDENTITY_KEY_SUFFIX}`;
    }

    private parseIdentityFromKey(identityKey: string): string {
        return identityKey.slice(
            this.IDENTITY_KEY_PREFIX.length,
            identityKey.length - this.IDENTITY_KEY_SUFFIX.length
        );
    }

    private async scanKeys(pattern: string): Promise<string[]> {
        const redis = this.redis as Redis & {
            scan?: (cursor: string, ...args: Array<string | number>) => Promise<[string, string[]]>;
        };

        if (typeof redis.scan !== 'function') {
            return await this.redis.keys(pattern);
        }

        const keys = new Set<string>();
        let cursor = '0';

        try {
            do {
                const [nextCursor, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
                cursor = nextCursor;
                for (const key of batch) {
                    keys.add(key);
                }
            } while (cursor !== '0');
        } catch (error) {
            console.warn('[RedisStorage] SCAN failed, falling back to KEYS:', error);
            return await this.redis.keys(pattern);
        }

        return Array.from(keys);
    }

    generateSessionId(): string {
        return firstChar() + rest();
    }

    async createSession(session: SessionData, ttl?: number): Promise<void> {
        const { sessionId, identity } = session;
        if (!sessionId || !identity) throw new Error('identity and sessionId required');

        const sessionKey = this.getSessionKey(identity, sessionId);
        const identityKey = this.getIdentityKey(identity);
        const effectiveTtl = ttl ?? this.DEFAULT_TTL;

        /** ioredis syntax: set(key, val, 'EX', ttl, 'NX') */
        const result = await this.redis.set(
            sessionKey,
            JSON.stringify(session),
            'EX',
            effectiveTtl,
            'NX'
        );

        if (result !== 'OK') {
            throw new Error(`Session ${sessionId} already exists`);
        }

        await this.redis.sadd(identityKey, sessionId);
    }
    async updateSession(identity: string, sessionId: string, data: Partial<SessionData>, ttl?: number): Promise<void> {
        const sessionKey = this.getSessionKey(identity, sessionId);
        const effectiveTtl = ttl ?? this.DEFAULT_TTL;

        /** Lua script for atomic parsing, merging, and saving */
        const script = `
            local currentStr = redis.call("GET", KEYS[1])
            if not currentStr then
                return 0
            end

            local current = cjson.decode(currentStr)
            local updates = cjson.decode(ARGV[1])

            for k,v in pairs(updates) do
                current[k] = v
            end

            redis.call("SET", KEYS[1], cjson.encode(current), "EX", ARGV[2])
            return 1
        `;

        const result = await this.redis.eval(
            script,
            1,
            sessionKey,
            JSON.stringify(data),
            effectiveTtl
        );

        if (result === 0) {
            throw new Error(`Session ${sessionId} not found for identity ${identity}`);
        }
    }

    async getSession(identity: string, sessionId: string): Promise<SessionData | null> {
        try {
            const sessionKey = this.getSessionKey(identity, sessionId);
            const sessionDataStr = await this.redis.get(sessionKey);

            if (!sessionDataStr) {
                return null;
            }

            const sessionData: SessionData = JSON.parse(sessionDataStr);
            return sessionData;
        } catch (error) {
            console.error('[RedisStorage] Failed to get session:', error);
            return null;
        }
    }

    async getIdentityMcpSessions(identity: string): Promise<string[]> {
        const sessions = await this.getIdentitySessionsData(identity);
        return sessions.map((session) => session.sessionId);
    }

    async getIdentitySessionsData(identity: string): Promise<SessionData[]> {
        try {
            const identityKey = this.getIdentityKey(identity);
            const sessionIds = await this.redis.smembers(identityKey);
            if (sessionIds.length === 0) return [];

            const results = await Promise.all(
                sessionIds.map(async (sessionId) => {
                    const data = await this.redis.get(this.getSessionKey(identity, sessionId));
                    return data ? (JSON.parse(data) as SessionData) : null;
                })
            );

            const staleSessionIds = sessionIds.filter((_, index) => results[index] === null);
            if (staleSessionIds.length > 0) {
                await this.redis.srem(identityKey, ...staleSessionIds);
            }

            return results.filter((session): session is SessionData => session !== null);
        } catch (error) {
            console.error(`[RedisStorage] Failed to get session data for ${identity}:`, error);
            return [];
        }
    }

    async removeSession(identity: string, sessionId: string): Promise<void> {
        try {
            const sessionKey = this.getSessionKey(identity, sessionId);
            const identityKey = this.getIdentityKey(identity);

            await this.redis.srem(identityKey, sessionId);
            await this.redis.del(sessionKey);
        } catch (error) {
            console.error('[RedisStorage] Failed to remove session:', error);
        }
    }

    async getAllSessionIds(): Promise<string[]> {
        try {
            const keys = await this.scanKeys(`${this.KEY_PREFIX}*`);
            const sessions = await Promise.all(
                keys.map(async (key) => {
                    const data = await this.redis.get(key);
                    if (!data) {
                        return null;
                    }

                    try {
                        return (JSON.parse(data) as SessionData).sessionId;
                    } catch (error) {
                        console.error('[RedisStorage] Failed to parse session while listing all session IDs:', error);
                        return null;
                    }
                })
            );

            return sessions.filter((sessionId): sessionId is string => sessionId !== null);
        } catch (error) {
            console.error('[RedisStorage] Failed to get all sessions:', error);
            return [];
        }
    }

    async clearAll(): Promise<void> {
        try {
            const keys = await this.scanKeys(`${this.KEY_PREFIX}*`);
            const identityKeys = await this.scanKeys(`${this.IDENTITY_KEY_PREFIX}*${this.IDENTITY_KEY_SUFFIX}`);
            const allKeys = [...keys, ...identityKeys];
            if (allKeys.length > 0) {
                await this.redis.del(...allKeys);
            }
        } catch (error) {
            console.error('[RedisStorage] Failed to clear sessions:', error);
        }
    }

    async cleanupExpiredSessions(): Promise<void> {
        try {
            const identityKeys = await this.scanKeys(`${this.IDENTITY_KEY_PREFIX}*${this.IDENTITY_KEY_SUFFIX}`);

            for (const identityKey of identityKeys) {
                const identity = this.parseIdentityFromKey(identityKey);
                const sessionIds = await this.redis.smembers(identityKey);

                if (sessionIds.length === 0) {
                    await this.redis.del(identityKey);
                    continue;
                }

                const existenceChecks = await Promise.all(
                    sessionIds.map((sessionId) => this.redis.exists(this.getSessionKey(identity, sessionId)))
                );

                const staleSessionIds = sessionIds.filter((_, index) => existenceChecks[index] === 0);
                if (staleSessionIds.length > 0) {
                    await this.redis.srem(identityKey, ...staleSessionIds);
                }

                const remainingCount = await this.redis.scard(identityKey);
                if (remainingCount === 0) {
                    await this.redis.del(identityKey);
                }
            }
        } catch (error) {
            console.error('[RedisStorage] Failed to cleanup expired sessions:', error);
        }
    }

    async disconnect(): Promise<void> {
        try {
            await this.redis.quit();
        } catch (error) {
            console.error('[RedisStorage] Failed to disconnect:', error);
        }
    }
}
