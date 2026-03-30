import type { SupabaseClient } from '@supabase/supabase-js';
import { StorageBackend, SessionData } from './types.js';
import { SESSION_TTL_SECONDS } from '../../shared/constants.js';

export class SupabaseStorageBackend implements StorageBackend {
    private readonly DEFAULT_TTL = SESSION_TTL_SECONDS;

    constructor(private supabase: SupabaseClient) {}

    generateSessionId(): string {
        return crypto.randomUUID();
    }

    private mapRowToSessionData(row: any): SessionData {
        return {
            sessionId: row.session_id,
            serverId: row.server_id,
            serverName: row.server_name,
            serverUrl: row.server_url,
            transportType: row.transport_type,
            callbackUrl: row.callback_url,
            createdAt: new Date(row.created_at).getTime(),
            identity: row.identity,
            headers: row.headers,
            active: row.active,
            clientInformation: row.client_information,
            tokens: row.tokens,
            codeVerifier: row.code_verifier,
            clientId: row.client_id,
        };
    }

    async createSession(session: SessionData, ttl?: number): Promise<void> {
        const { sessionId, identity } = session;
        if (!sessionId || !identity) throw new Error('identity and sessionId required');

        const effectiveTtl = ttl ?? this.DEFAULT_TTL;
        const expiresAt = new Date(Date.now() + effectiveTtl * 1000).toISOString();

        const { error } = await this.supabase
            .from('mcp_sessions')
            .insert({
                session_id: sessionId,
                user_id: identity, // Maps user_id to identity to support RLS using auth.uid()
                server_id: session.serverId,
                server_name: session.serverName,
                server_url: session.serverUrl,
                transport_type: session.transportType,
                callback_url: session.callbackUrl,
                created_at: new Date(session.createdAt || Date.now()).toISOString(),
                identity: identity,
                headers: session.headers,
                active: session.active ?? false,
                client_information: session.clientInformation,
                tokens: session.tokens,
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

    async updateSession(identity: string, sessionId: string, data: Partial<SessionData>, ttl?: number): Promise<void> {
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
        if ('headers' in data) updateData.headers = data.headers;
        if ('clientInformation' in data) updateData.client_information = data.clientInformation;
        if ('tokens' in data) updateData.tokens = data.tokens;
        if ('codeVerifier' in data) updateData.code_verifier = data.codeVerifier;
        if ('clientId' in data) updateData.client_id = data.clientId;

        const { data: updatedRows, error } = await this.supabase
            .from('mcp_sessions')
            .update(updateData)
            .eq('identity', identity)
            .eq('session_id', sessionId)
            .select('id');

        if (error) {
            throw new Error(`Failed to update session: ${error.message}`);
        }

        if (!updatedRows || updatedRows.length === 0) {
            throw new Error(`Session ${sessionId} not found for identity ${identity}`);
        }
    }

    async getSession(identity: string, sessionId: string): Promise<SessionData | null> {
        const { data, error } = await this.supabase
            .from('mcp_sessions')
            .select('*')
            .eq('identity', identity)
            .eq('session_id', sessionId)
            .maybeSingle();

        if (error) {
            console.error('[SupabaseStorage] Failed to get session:', error);
            return null;
        }

        if (!data) return null;

        return this.mapRowToSessionData(data);
    }

    async getIdentitySessionsData(identity: string): Promise<SessionData[]> {
        const { data, error } = await this.supabase
            .from('mcp_sessions')
            .select('*')
            .eq('identity', identity);

        if (error) {
            console.error(`[SupabaseStorage] Failed to get session data for ${identity}:`, error);
            return [];
        }

        return data.map(row => this.mapRowToSessionData(row));
    }

    async removeSession(identity: string, sessionId: string): Promise<void> {
        const { error } = await this.supabase
            .from('mcp_sessions')
            .delete()
            .eq('identity', identity)
            .eq('session_id', sessionId);

        if (error) {
            console.error('[SupabaseStorage] Failed to remove session:', error);
        }
    }

    async getIdentityMcpSessions(identity: string): Promise<string[]> {
        const { data, error } = await this.supabase
            .from('mcp_sessions')
            .select('session_id')
            .eq('identity', identity);

        if (error) {
            console.error(`[SupabaseStorage] Failed to get sessions for ${identity}:`, error);
            return [];
        }

        return data.map(row => row.session_id);
    }

    async getAllSessionIds(): Promise<string[]> {
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

    async cleanupExpiredSessions(): Promise<void> {
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
