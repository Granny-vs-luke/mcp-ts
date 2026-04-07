import { StorageBackend, SessionData } from './types.js';
import { generateSessionId } from '../../shared/utils.js';

export interface LocalStorageBackendOptions {
    /**
     * Prefix for all localStorage keys (default: "mcp-ts").
     * Useful to avoid key collisions when multiple apps share the same origin.
     */
    namespace?: string;

    /**
     * Default session TTL in seconds (default: 43200 = 12 hours).
     * Pass 0 to disable TTL (sessions persist indefinitely).
     */
    defaultTtl?: number;
}

/**
 * Browser-only LocalStorage implementation of StorageBackend.
 *
 * ⚠️  Security notice: localStorage is accessible to any JavaScript running
 * on the same origin and is therefore vulnerable to XSS attacks.
 * Do NOT use this backend when you need to protect OAuth tokens in high-security
 * contexts. Prefer Redis or Supabase for server-side deployments.
 *
 * Key schema:
 *   <ns>:session:<identity>:<sessionId>  →  JSON { ...SessionData, _expiresAt?: number }
 *   <ns>:idx:<identity>                  →  JSON string[] of sessionIds
 *   <ns>:identities                      →  JSON string[] of all known identities
 */
export class LocalStorageBackend implements StorageBackend {
    private readonly ns: string;
    private readonly defaultTtl: number;
    private initialized = false;

    constructor(options: LocalStorageBackendOptions = {}) {
        this.ns = options.namespace ?? 'mcp-ts';
        this.defaultTtl = options.defaultTtl ?? 43200; // 12 hours
    }

    // ─── Key helpers ────────────────────────────────────────────────────────

    private sessionKey(identity: string, sessionId: string): string {
        return `${this.ns}:session:${identity}:${sessionId}`;
    }

    private idxKey(identity: string): string {
        return `${this.ns}:idx:${identity}`;
    }

    private get identitiesKey(): string {
        return `${this.ns}:identities`;
    }

    // ─── Low-level helpers ────────────────────────────────────────────────

    private getLS(): Storage {
        if (typeof window === 'undefined' || !window.localStorage) {
            throw new Error(
                '[LocalStorageBackend] window.localStorage is not available. ' +
                'This backend can only be used in browser environments.'
            );
        }
        return window.localStorage;
    }

    private readJSON<T>(key: string): T | null {
        try {
            const raw = this.getLS().getItem(key);
            return raw ? (JSON.parse(raw) as T) : null;
        } catch {
            return null;
        }
    }

    private writeJSON(key: string, value: unknown): void {
        this.getLS().setItem(key, JSON.stringify(value));
    }

    /** Returns null if the session is expired (and removes it from storage). */
    private readSession(identity: string, sessionId: string): (SessionData & { _expiresAt?: number }) | null {
        const key = this.sessionKey(identity, sessionId);
        const raw = this.readJSON<SessionData & { _expiresAt?: number }>(key);
        if (!raw) return null;

        if (raw._expiresAt && Date.now() > raw._expiresAt) {
            // Lazy eviction
            this.getLS().removeItem(key);
            this._removeFromIndex(identity, sessionId);
            return null;
        }

        return raw;
    }

    // ─── Identity index helpers ───────────────────────────────────────────

    private getIndex(identity: string): string[] {
        return this.readJSON<string[]>(this.idxKey(identity)) ?? [];
    }

    private setIndex(identity: string, ids: string[]): void {
        this.writeJSON(this.idxKey(identity), ids);
    }

    private _addToIndex(identity: string, sessionId: string): void {
        const ids = this.getIndex(identity);
        if (!ids.includes(sessionId)) {
            ids.push(sessionId);
            this.setIndex(identity, ids);
        }

        // Track the identity globally
        const allIdentities = this.readJSON<string[]>(this.identitiesKey) ?? [];
        if (!allIdentities.includes(identity)) {
            allIdentities.push(identity);
            this.writeJSON(this.identitiesKey, allIdentities);
        }
    }

    _removeFromIndex(identity: string, sessionId: string): void {
        const ids = this.getIndex(identity).filter(id => id !== sessionId);
        this.setIndex(identity, ids);
    }

    // ─── StorageBackend interface ─────────────────────────────────────────

    async init(): Promise<void> {
        if (this.initialized) return;

        // Will throw if not in a browser
        this.getLS();

        this.initialized = true;
        console.log(`[mcp-ts][Storage] LocalStorage: ✓ namespace "${this.ns}" ready.`);
    }

    generateSessionId(): string {
        return generateSessionId();
    }

    async createSession(session: SessionData, ttl?: number): Promise<void> {
        const { sessionId, identity } = session;
        if (!sessionId || !identity) throw new Error('identity and sessionId required');

        const key = this.sessionKey(identity, sessionId);
        if (this.getLS().getItem(key) !== null) {
            // Check it's not expired before throwing
            if (this.readSession(identity, sessionId) !== null) {
                throw new Error(`Session ${sessionId} already exists`);
            }
        }

        const effectiveTtl = ttl ?? this.defaultTtl;
        const stored: SessionData & { _expiresAt?: number } = { ...session };
        if (effectiveTtl > 0) {
            stored._expiresAt = Date.now() + effectiveTtl * 1000;
        }

        this.writeJSON(key, stored);
        this._addToIndex(identity, sessionId);
    }

    async updateSession(
        identity: string,
        sessionId: string,
        data: Partial<SessionData>,
        ttl?: number
    ): Promise<void> {
        if (!identity || !sessionId) throw new Error('identity and sessionId required');

        const current = this.readSession(identity, sessionId);
        if (!current) throw new Error(`Session ${sessionId} not found`);

        const effectiveTtl = ttl ?? this.defaultTtl;
        const updated: SessionData & { _expiresAt?: number } = { ...current, ...data };
        if (effectiveTtl > 0) {
            updated._expiresAt = Date.now() + effectiveTtl * 1000;
        }

        this.writeJSON(this.sessionKey(identity, sessionId), updated);
    }

    async getSession(identity: string, sessionId: string): Promise<SessionData | null> {
        const raw = this.readSession(identity, sessionId);
        if (!raw) return null;

        // Strip internal TTL field before returning
        const { _expiresAt, ...session } = raw;
        return session as SessionData;
    }

    async getIdentitySessionsData(identity: string): Promise<SessionData[]> {
        const ids = this.getIndex(identity);
        const results: SessionData[] = [];

        for (const sessionId of ids) {
            const raw = this.readSession(identity, sessionId);
            if (raw) {
                const { _expiresAt, ...session } = raw;
                results.push(session as SessionData);
            }
        }

        return results;
    }

    async getIdentityMcpSessions(identity: string): Promise<string[]> {
        const ids = this.getIndex(identity);
        // Filter out expired ones (lazy eviction via readSession)
        const active: string[] = [];
        for (const id of ids) {
            if (this.readSession(identity, id) !== null) {
                active.push(id);
            }
        }
        return active;
    }

    async removeSession(identity: string, sessionId: string): Promise<void> {
        this.getLS().removeItem(this.sessionKey(identity, sessionId));
        this._removeFromIndex(identity, sessionId);
    }

    async getAllSessionIds(): Promise<string[]> {
        const allIdentities = this.readJSON<string[]>(this.identitiesKey) ?? [];
        const allIds: string[] = [];

        for (const identity of allIdentities) {
            const ids = await this.getIdentityMcpSessions(identity);
            allIds.push(...ids);
        }

        return allIds;
    }

    async clearAll(): Promise<void> {
        const ls = this.getLS();
        const keysToRemove: string[] = [];

        for (let i = 0; i < ls.length; i++) {
            const key = ls.key(i);
            if (key && key.startsWith(`${this.ns}:`)) {
                keysToRemove.push(key);
            }
        }

        for (const key of keysToRemove) {
            ls.removeItem(key);
        }
    }

    async cleanupExpiredSessions(): Promise<void> {
        const allIdentities = this.readJSON<string[]>(this.identitiesKey) ?? [];

        for (const identity of allIdentities) {
            const ids = this.getIndex(identity);
            for (const sessionId of ids) {
                // readSession already does lazy eviction
                this.readSession(identity, sessionId);
            }
        }
    }

    async disconnect(): Promise<void> {
        // No persistent connection to close
    }
}
