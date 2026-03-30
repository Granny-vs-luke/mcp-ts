
import { RedisStorageBackend } from './redis-backend';
import { MemoryStorageBackend } from './memory-backend';
import { FileStorageBackend } from './file-backend';
import { SqliteStorage } from './sqlite-backend.js';
import { SupabaseStorageBackend } from './supabase-backend.js';
import type { StorageBackend } from './types.js';

// Re-export types
export * from './types.js';
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
            console.log('[Storage] Using Redis storage (Explicit)');
            return new RedisStorageBackend(redis);
        } catch (error: any) {
            console.error('[Storage] Failed to initialize Redis:', error.message);
            console.log('[Storage] Falling back to In-Memory storage');
            return new MemoryStorageBackend();
        }
    }

    if (type === 'file') {
        const filePath = process.env.MCP_TS_STORAGE_FILE;
        if (!filePath) {
            console.warn('[Storage] MCP_TS_STORAGE_TYPE is "file" but MCP_TS_STORAGE_FILE is missing');
        }
        console.log(`[Storage] Using File storage (${filePath}) (Explicit)`);
        return await initializeStorage(new FileStorageBackend({ path: filePath }));
    }

    if (type === 'sqlite') {
        const dbPath = process.env.MCP_TS_STORAGE_SQLITE_PATH;
        console.log(`[Storage] Using SQLite storage (${dbPath || 'default'}) (Explicit)`);
        return await initializeStorage(new SqliteStorage({ path: dbPath }));
    }

    if (type === 'supabase') {
        const url = process.env.SUPABASE_URL;
        const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
        
        if (!url || !key) {
            console.warn('[Storage] MCP_TS_STORAGE_TYPE is "supabase" but SUPABASE_URL and a key are missing');
        } else {
            try {
                const { createClient } = await import('@supabase/supabase-js');
                const client = createClient(url, key);
                console.log('[Storage] Using Supabase storage (Explicit)');
                return await initializeStorage(new SupabaseStorageBackend(client as any));
            } catch (error: any) {
                console.error('[Storage] Failed to initialize Supabase:', error.message);
                console.log('[Storage] Falling back to In-Memory storage');
                return new MemoryStorageBackend();
            }
        }
    }

    if (type === 'memory') {
        console.log('[Storage] Using In-Memory storage (Explicit)');
        return new MemoryStorageBackend();
    }

    // Automatic inference (Fallback)
    if (process.env.REDIS_URL) {
        try {
            const { getRedis } = await import('./redis.js');
            const redis = await getRedis();
            console.log('[Storage] Auto-detected REDIS_URL. Using Redis storage.');
            return new RedisStorageBackend(redis);
        } catch (error: any) {
            console.error('[Storage] Redis auto-detection failed:', error.message);
            console.log('[Storage] Falling back to In-Memory storage');
            return new MemoryStorageBackend();
        }
    }

    if (process.env.MCP_TS_STORAGE_FILE) {
        console.log(`[Storage] Auto-detected MCP_TS_STORAGE_FILE. Using File storage (${process.env.MCP_TS_STORAGE_FILE}).`);
        return await initializeStorage(new FileStorageBackend({ path: process.env.MCP_TS_STORAGE_FILE }));
    }

    if (process.env.MCP_TS_STORAGE_SQLITE_PATH) {
        console.log(`[Storage] Auto-detected MCP_TS_STORAGE_SQLITE_PATH. Using SQLite storage (${process.env.MCP_TS_STORAGE_SQLITE_PATH}).`);
        return await initializeStorage(new SqliteStorage({ path: process.env.MCP_TS_STORAGE_SQLITE_PATH }));
    }

    console.log('[Storage] No storage configured. Using In-Memory storage (Default).');
    return new MemoryStorageBackend();
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
