import type { SupabaseClient } from '@supabase/supabase-js';
import type { SessionStore, Session } from './types.js';
import { SESSION_TTL_SECONDS } from '../../shared/constants.js';
import { generateSessionId } from '../../shared/utils.js';
import { encryptObject, decryptObject } from './crypto.js';

export class SupabaseStorageBackend implements SessionStore {
    private readonly DEFAULT_TTL = SESSION_TTL_SECONDS;

    constructor(private supabase: SupabaseClient) {}
    
    async init(): Promise<void> {
        // Validate that the table exists
        const { error } = await this.supabase
            .from('mcp_sessions')
            .select('session_id')
            .limit(0);

        if (error) {
            // Postgres error code 42P01 is "relation does not exist"
            if (error.code === '42P01') {
                throw new Error(
                    '[SupabaseStorage] Table "mcp_sessions" not found in your database. ' +
                    'Please run "npx mcp-ts supabase-init" in your project to set up the required table and RLS policies.'
                );
            }
            throw new Error(`[SupabaseStorage] Initialization check failed: ${error.message}`);
        }

        console.log('[mcp-ts][Storage] Supabase: ✓ "mcp_sessions" table verified.');
    }

    generateSessionId(): string {
        return generateSessionId();
    }

    private mapRowToSessionData(row: any): Session {
        return {
            sessionId: row.session_id,
            serverId: row.server_id,
            serverName: row.server_name,
            serverUrl: row.server_url,
            transportType: row.transport_type,
            callbackUrl: row.callback_url,
            createdAt: new Date(row.created_at).getTime(),
            userId: row.user_id,
            headers: decryptObject(row.headers),
            active: row.active,
            clientInformation: row.client_information,
            tokens: decryptObject(row.tokens),
            codeVerifier: row.code_verifier,
            clientId: row.client_id,
        };
    }

    async create(session: Session, ttl?: number): Promise<void> {
        const { sessionId, userId } = session;
        if (!sessionId || !userId) throw new Error('userId and sessionId required');

        const effectiveTtl = ttl ?? this.DEFAULT_TTL;
        const expiresAt = new Date(Date.now() + effectiveTtl * 1000).toISOString();

        const { error } = await this.supabase
            .from('mcp_sessions')
            .insert({
                session_id: sessionId,
                user_id: userId, // Maps user_id to userId to support RLS using auth.uid()
                server_id: session.serverId,
                server_name: session.serverName,
                server_url: session.serverUrl,
                transport_type: session.transportType,
                callback_url: session.callbackUrl,
                created_at: new Date(session.createdAt || Date.now()).toISOString(),
                headers: encryptObject(session.headers),
                active: session.active ?? false,
                client_information: session.clientInformation,
                tokens: encryptObject(session.tokens),
                code_verifier: session.codeVerifier,
                client_id: session.clientId,
                expires_at: expiresAt
            });

        if (error) {
            // Postgres error code 23505 is unique violation
            if (error.code === '23505') {
                throw new Error(`Session ${sessionId} already exists`);
            }
            throw new Error(`Failed to create session in Supabase: ${error.message}`);
        }
    }

    async update(userId: string, sessionId: string, data: Partial<Session>, ttl?: number): Promise<void> {
        const effectiveTtl = ttl ?? this.DEFAULT_TTL;
        const expiresAt = new Date(Date.now() + effectiveTtl * 1000).toISOString();

        // Convert the camelCase keys to snake_case for Supabase
        const updateData: any = {
            expires_at: expiresAt,
            updated_at: new Date().toISOString()
        };

        if ('serverId' in data) updateData.server_id = data.serverId;
        if ('serverName' in data) updateData.server_name = data.serverName;
        if ('serverUrl' in data) updateData.server_url = data.serverUrl;
        if ('transportType' in data) updateData.transport_type = data.transportType;
        if ('callbackUrl' in data) updateData.callback_url = data.callbackUrl;
        if ('active' in data) updateData.active = data.active;
        if ('headers' in data) updateData.headers = encryptObject(data.headers);
        if ('clientInformation' in data) updateData.client_information = data.clientInformation;
        if ('tokens' in data) updateData.tokens = data.tokens === undefined ? null : encryptObject(data.tokens);
        if ('codeVerifier' in data) updateData.code_verifier = data.codeVerifier;
        if ('clientId' in data) updateData.client_id = data.clientId;

        const { data: updatedRows, error } = await this.supabase
            .from('mcp_sessions')
            .update(updateData)
            .eq('user_id', userId)
            .eq('session_id', sessionId)
            .select('id');

        if (error) {
            throw new Error(`Failed to update session: ${error.message}`);
        }

        if (!updatedRows || updatedRows.length === 0) {
            throw new Error(`Session ${sessionId} not found for userId ${userId}`);
        }
    }

    async get(userId: string, sessionId: string): Promise<Session | null> {
        const { data, error } = await this.supabase
            .from('mcp_sessions')
            .select('*')
            .eq('user_id', userId)
            .eq('session_id', sessionId)
            .maybeSingle();

        if (error) {
            console.error('[SupabaseStorage] Failed to get session:', error);
            return null;
        }

        if (!data) return null;

        return this.mapRowToSessionData(data);
    }

    async list(userId: string): Promise<Session[]> {
        const { data, error } = await this.supabase
            .from('mcp_sessions')
            .select('*')
            .eq('user_id', userId);

        if (error) {
            console.error(`[SupabaseStorage] Failed to get session data for ${userId}:`, error);
            return [];
        }

        return data.map(row => this.mapRowToSessionData(row));
    }

    async delete(userId: string, sessionId: string): Promise<void> {
        const { error } = await this.supabase
            .from('mcp_sessions')
            .delete()
            .eq('user_id', userId)
            .eq('session_id', sessionId);

        if (error) {
            console.error('[SupabaseStorage] Failed to remove session:', error);
        }
    }

    async listIds(userId: string): Promise<string[]> {
        const { data, error } = await this.supabase
            .from('mcp_sessions')
            .select('session_id')
            .eq('user_id', userId);

        if (error) {
            console.error(`[SupabaseStorage] Failed to get sessions for ${userId}:`, error);
            return [];
        }

        return data.map(row => row.session_id);
    }

    async listAllIds(): Promise<string[]> {
        const { data, error } = await this.supabase
            .from('mcp_sessions')
            .select('session_id');

        if (error) {
            console.error('[SupabaseStorage] Failed to get all sessions:', error);
            return [];
        }

        return data.map(row => row.session_id);
    }

    async clearAll(): Promise<void> {
        // Warning: This deletes everything. Typically only used in testing.
        const { error } = await this.supabase
            .from('mcp_sessions')
            .delete()
            .neq('session_id', ''); // Delete all rows trick
            
        if (error) {
            console.error('[SupabaseStorage] Failed to clear sessions:', error);
        }
    }

    async cleanupExpired(): Promise<void> {
        const { error } = await this.supabase
            .from('mcp_sessions')
            .delete()
            .lt('expires_at', new Date().toISOString());

        if (error) {
            console.error('[SupabaseStorage] Failed to cleanup expired sessions:', error);
        }
    }

    async disconnect(): Promise<void> {
        // Supabase client handles its own connection pooling over HTTP, 
        // there is no explicit disconnect method.
    }
}
