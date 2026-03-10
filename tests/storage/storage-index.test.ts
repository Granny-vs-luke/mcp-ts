import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { storage, _setStorageInstanceForTesting } from '../../src/server/storage';
import { createMockSession } from '../test-utils';

test.describe('storage index bootstrap', () => {
    const originalEnv = {
        MCP_TS_STORAGE_TYPE: process.env.MCP_TS_STORAGE_TYPE,
        MCP_TS_STORAGE_SQLITE_PATH: process.env.MCP_TS_STORAGE_SQLITE_PATH,
        MCP_TS_STORAGE_FILE: process.env.MCP_TS_STORAGE_FILE,
        REDIS_URL: process.env.REDIS_URL,
    };

    let dbPath: string;

    test.beforeEach(() => {
        dbPath = path.join(__dirname, `storage-index-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
        _setStorageInstanceForTesting(null);
        delete process.env.REDIS_URL;
        delete process.env.MCP_TS_STORAGE_FILE;
    });

    test.afterEach(async () => {
        try {
            await storage.disconnect();
        } catch {
            // Storage may not have been initialized for a given test.
        }

        _setStorageInstanceForTesting(null);
        process.env.MCP_TS_STORAGE_TYPE = originalEnv.MCP_TS_STORAGE_TYPE;
        process.env.MCP_TS_STORAGE_SQLITE_PATH = originalEnv.MCP_TS_STORAGE_SQLITE_PATH;
        process.env.MCP_TS_STORAGE_FILE = originalEnv.MCP_TS_STORAGE_FILE;
        process.env.REDIS_URL = originalEnv.REDIS_URL;

        for (const suffix of ['', '-journal', '-shm', '-wal']) {
            const filePath = `${dbPath}${suffix}`;
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
            }
        }
    });

    test('awaits sqlite initialization before the first proxied operation', async () => {
        process.env.MCP_TS_STORAGE_TYPE = 'sqlite';
        process.env.MCP_TS_STORAGE_SQLITE_PATH = dbPath;

        const session = createMockSession({
            sessionId: 'sqlite-bootstrap-session',
            transportType: 'streamable_http',
        });

        await storage.createSession(session);

        const retrieved = await storage.getSession(session.identity, session.sessionId);
        expect(retrieved?.sessionId).toBe(session.sessionId);
        expect(retrieved?.transportType).toBe('streamable_http');
    });
});
