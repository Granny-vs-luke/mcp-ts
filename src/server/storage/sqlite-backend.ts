import type { Database } from 'better-sqlite3';
import { StorageBackend, SessionData } from './types.js'; // Ensure .js extension
import * as fs from 'fs';
import * as path from 'path';
import { generateSessionId } from '../../shared/utils.js';

export interface SqliteStorageOptions {
    path?: string;
    table?: string;
}

export class SqliteStorage implements StorageBackend {
    private db: Database | null = null;
    private table: string;
    private initialized = false;
    private dbPath: string;

    constructor(options: SqliteStorageOptions = {}) {
        this.dbPath = options.path || './sessions.db';
        this.table = options.table || 'mcp_sessions';
    }

    async init(): Promise<void> {
        if (this.initialized) return;

        try {
            // Dynamic import for peer dependency
            const DatabaseConstructor = (await import('better-sqlite3')).default;

            // Ensure directory exists
            const dir = path.dirname(this.dbPath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }

            this.db = new DatabaseConstructor(this.dbPath);
            this.db.exec(`
                CREATE TABLE IF NOT EXISTS ${this.table} (
                    sessionId TEXT PRIMARY KEY,
                    userId TEXT NOT NULL,
                    data TEXT NOT NULL,
                    expiresAt INTEGER
                );
                CREATE INDEX IF NOT EXISTS idx_${this.table}_userId ON ${this.table}(userId);
            `);

            this.initialized = true;
            console.log(`[mcp-ts][Storage] SQLite: ✓ database at ${this.dbPath} verified.`);
        } catch (error: any) {
            if (error.code === 'MODULE_NOT_FOUND' || error.message?.includes('better-sqlite3')) {
                throw new Error(
                    'better-sqlite3 is not installed. Please install it with: npm install better-sqlite3'
                );
            }
            throw error;
        }
    }

    private ensureInitialized() {
        if (!this.initialized) {
            throw new Error('SqliteStorage not initialized. Call init() first.');
        }
    }

    generateSessionId(): string {
        return generateSessionId();
    }

    async createSession(session: SessionData, ttl?: number): Promise<void> {
        this.ensureInitialized();
        const { sessionId, userId } = session;

        if (!sessionId || !userId) {
            throw new Error('userId and sessionId required');
        }

        const expiresAt = ttl ? Date.now() + ttl * 1000 : null;

        try {
            const stmt = this.db!.prepare(
                `INSERT INTO ${this.table} (sessionId, userId, data, expiresAt) VALUES (?, ?, ?, ?)`
            );
            stmt.run(sessionId, userId, JSON.stringify(session), expiresAt);
        } catch (error: any) {
            if (error.code === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
                throw new Error(`Session ${sessionId} already exists`);
            }
            throw error;
        }
    }

    async updateSession(userId: string, sessionId: string, data: Partial<SessionData>, ttl?: number): Promise<void> {
        this.ensureInitialized();
        if (!sessionId || !userId) {
            throw new Error('userId and sessionId required');
        }

        const currentSession = await this.getSession(userId, sessionId);
        if (!currentSession) {
            throw new Error(`Session ${sessionId} not found for userId ${userId}`);
        }

        const updatedSession = { ...currentSession, ...data };
        const expiresAt = ttl ? Date.now() + ttl * 1000 : null;

        const stmt = this.db!.prepare(
            `UPDATE ${this.table} SET data = ?, expiresAt = ? WHERE sessionId = ? AND userId = ?`
        );

        stmt.run(JSON.stringify(updatedSession), expiresAt, sessionId, userId);
    }

    async getSession(userId: string, sessionId: string): Promise<SessionData | null> {
        this.ensureInitialized();

        const stmt = this.db!.prepare(
            `SELECT data FROM ${this.table} WHERE sessionId = ? AND userId = ?`
        );
        const row = stmt.get(sessionId, userId) as { data: string } | undefined;

        if (!row) return null;
        return JSON.parse(row.data) as SessionData;
    }

    async listSessions(userId: string): Promise<SessionData[]> {
        this.ensureInitialized();

        const stmt = this.db!.prepare(
            `SELECT data FROM ${this.table} WHERE userId = ?`
        );
        const rows = stmt.all(userId) as { data: string }[];

        return rows.map(row => JSON.parse(row.data) as SessionData);
    }

    async listSessionIds(userId: string): Promise<string[]> {
        this.ensureInitialized();

        const stmt = this.db!.prepare(
            `SELECT sessionId FROM ${this.table} WHERE userId = ?`
        );
        const rows = stmt.all(userId) as { sessionId: string }[];

        return rows.map(row => row.sessionId);
    }

    async deleteSession(userId: string, sessionId: string): Promise<void> {
        this.ensureInitialized();
        const stmt = this.db!.prepare(
            `DELETE FROM ${this.table} WHERE sessionId = ? AND userId = ?`
        );
        stmt.run(sessionId, userId);
    }

    async listGlobalSessionIds(): Promise<string[]> {
        this.ensureInitialized();
        const stmt = this.db!.prepare(`SELECT sessionId FROM ${this.table}`);
        const rows = stmt.all() as { sessionId: string }[];
        return rows.map(row => row.sessionId);
    }

    async clearGlobalSessions(): Promise<void> {
        this.ensureInitialized();
        const stmt = this.db!.prepare(`DELETE FROM ${this.table}`);
        stmt.run();
    }

    async cleanupExpiredSessions(): Promise<void> {
        this.ensureInitialized();
        const now = Date.now();
        const stmt = this.db!.prepare(
            `DELETE FROM ${this.table} WHERE expiresAt IS NOT NULL AND expiresAt < ?`
        );
        stmt.run(now);
    }

    async disconnect(): Promise<void> {
        if (this.db) {
            this.db.close();
        }
    }
}
