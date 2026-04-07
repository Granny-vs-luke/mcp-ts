
import { RedisStorageBackend } from './redis-backend';
import { MemoryStorageBackend } from './memory-backend';
import { FileStorageBackend } from './file-backend';
import { SqliteStorage } from './sqlite-backend.js';
import { SupabaseStorageBackend } from './supabase-backend.js';
import type { StorageBackend } from '../../shared/storage.js';

// Re-export storage types from the shared layer so consumers
// can import them from the familiar '@mcp-ts/sdk/server' path.
export type { StorageBackend, SessionData } from '../../shared/storage.js';
export { generateSessionId } from '../../shared/utils.js';
export { RedisStorageBackend, MemoryStorageBackend, FileStorageBackend, SqliteStorage, SupabaseStorageBackend };

export function createSupabaseStorageBackend(client: any): SupabaseStorageBackend {
    return new SupabaseStorageBackend(client);
}

let storageInstance: StorageBackend | null = null;
let storagePromise: Promise<StorageBackend> | null = null;

async function initializeStorage<T extends StorageBackend>(store: T): Promise<T> {
    if (typeof store.init === 'function') {
        await store.init();
    }
    return store;
}

async function createStorage(): Promise<StorageBackend> {
    const type = process.env.MCP_TS_STORAGE_TYPE?.toLowerCase();

    // Explicit selection
    if (type === 'redis') {
        if (!process.env.REDIS_URL) {
            console.warn('[Storage] MCP_TS_STORAGE_TYPE is "redis" but REDIS_URL is missing');
        }
        try {
            const { getRedis } = await import('./redis.js');
            const redis = await getRedis();
            console.log('[mcp-ts][Storage] Explicit selection: "redis"');
            return await initializeStorage(new RedisStorageBackend(redis));
        } catch (error: any) {
            console.error('[mcp-ts][Storage] Failed to initialize Redis:', error.message);
            console.log('[mcp-ts][Storage] Falling back to In-Memory storage');
            return await initializeStorage(new MemoryStorageBackend());
        }
    }

    if (type === 'file') {
        const filePath = process.env.MCP_TS_STORAGE_FILE;
        console.log(`[mcp-ts][Storage] Explicit selection: "file" (${filePath || 'default'})`);
        return await initializeStorage(new FileStorageBackend({ path: filePath }));
    }

    if (type === 'sqlite') {
        const dbPath = process.env.MCP_TS_STORAGE_SQLITE_PATH;
        console.log(`[mcp-ts][Storage] Explicit selection: "sqlite" (${dbPath || 'default'})`);
        return await initializeStorage(new SqliteStorage({ path: dbPath }));
    }

    if (type === 'supabase') {
        const url = process.env.SUPABASE_URL;
        const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
        
        if (!url || !key) {
            console.warn('[mcp-ts][Storage] Explicit selection "supabase" requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
        } else {
            if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
                console.warn('[mcp-ts][Storage] ⚠️  Warning: Using "SUPABASE_ANON_KEY" for server-side storage. You may encounter RLS policy violations. "SUPABASE_SERVICE_ROLE_KEY" is recommended.');
            }
            try {
                const { createClient } = await import('@supabase/supabase-js');
                const client = createClient(url, key);
                console.log('[mcp-ts][Storage] Explicit selection: "supabase"');
                return await initializeStorage(new SupabaseStorageBackend(client as any));
            } catch (error: any) {
                console.error('[mcp-ts][Storage] Failed to initialize Supabase:', error.message);
                console.log('[mcp-ts][Storage] Falling back to In-Memory storage');
                return await initializeStorage(new MemoryStorageBackend());
            }
        }
    }

    if (type === 'memory') {
        console.log('[mcp-ts][Storage] Explicit selection: "memory"');
        return await initializeStorage(new MemoryStorageBackend());
    }

    // Automatic inference (Fallback)
    if (process.env.REDIS_URL) {
        try {
            const { getRedis } = await import('./redis.js');
            const redis = await getRedis();
            console.log('[mcp-ts][Storage] Auto-detection: "redis" (via REDIS_URL)');
            return await initializeStorage(new RedisStorageBackend(redis));
        } catch (error: any) {
            console.error('[mcp-ts][Storage] Redis auto-detection failed:', error.message);
            console.log('[mcp-ts][Storage] Falling back to next available backend');
        }
    }

    if (process.env.MCP_TS_STORAGE_FILE) {
        console.log(`[mcp-ts][Storage] Auto-detection: "file" (${process.env.MCP_TS_STORAGE_FILE})`);
        return await initializeStorage(new FileStorageBackend({ path: process.env.MCP_TS_STORAGE_FILE }));
    }

    if (process.env.MCP_TS_STORAGE_SQLITE_PATH) {
        console.log(`[mcp-ts][Storage] Auto-detection: "sqlite" (${process.env.MCP_TS_STORAGE_SQLITE_PATH})`);
        return await initializeStorage(new SqliteStorage({ path: process.env.MCP_TS_STORAGE_SQLITE_PATH }));
    }

    if (process.env.SUPABASE_URL && (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY)) {
        try {
            const { createClient } = await import('@supabase/supabase-js');
            const url = process.env.SUPABASE_URL;
            const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY!;
            
            if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
                console.warn('[mcp-ts][Storage] ⚠️ Warning: Using "SUPABASE_ANON_KEY" for server-side storage. You may encounter RLS policy violations. "SUPABASE_SERVICE_ROLE_KEY" is recommended.');
            }

            const client = createClient(url, key);
            console.log('[mcp-ts][Storage] Auto-detection: "supabase" (via SUPABASE_URL)');
            return await initializeStorage(new SupabaseStorageBackend(client as any));
        } catch (error: any) {
            console.error('[mcp-ts][Storage] Supabase auto-detection failed:', error.message);
        }
    }

    console.log('[mcp-ts][Storage] Defaulting to: "memory" (server detected)');
    return await initializeStorage(new MemoryStorageBackend());
}

async function getStorage(): Promise<StorageBackend> {
    if (storageInstance) {
        return storageInstance;
    }

    if (!storagePromise) {
        storagePromise = createStorage().catch((error) => {
            storagePromise = null;
            throw error;
        });
    }

    storageInstance = await storagePromise;
    return storageInstance;
}

/**
 * Set the storage instance (for testing)
 * @internal
 * @param instance - StorageBackend instance or null to reset
 */
export function _setStorageInstanceForTesting(instance: StorageBackend | null): void {
    storageInstance = instance;
    if (!instance) {
        storagePromise = null;
    }
}

/**
 * Global session store instance
 * Uses lazy initialization with a Proxy to handle async setup transparently
 */
export const storage: StorageBackend = new Proxy({} as StorageBackend, {
    get(_target, prop) {
        if (prop === 'then') return undefined;
        return async (...args: any[]) => {
            const instance = await getStorage();
            const value = (instance as any)[prop];
            if (typeof value === 'function') {
                return value.apply(instance, args);
            }
            return value;
        };
    },
});
