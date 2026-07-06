-- Merge mcp_credentials into mcp_sessions (single-table design).
-- Migration for existing databases that have the separate mcp_credentials table.
--
-- Run this as an owner/admin role after upgrading @mcp-ts/sdk.

-- Add credential columns to mcp_sessions
ALTER TABLE public.mcp_sessions ADD COLUMN IF NOT EXISTS client_information JSONB;
ALTER TABLE public.mcp_sessions ADD COLUMN IF NOT EXISTS tokens JSONB;
ALTER TABLE public.mcp_sessions ADD COLUMN IF NOT EXISTS code_verifier TEXT;
ALTER TABLE public.mcp_sessions ADD COLUMN IF NOT EXISTS client_id TEXT;
ALTER TABLE public.mcp_sessions ADD COLUMN IF NOT EXISTS oauth_state JSONB;

-- Migrate existing credential data into session rows
UPDATE public.mcp_sessions s
SET
    client_information = c.client_information,
    tokens = c.tokens,
    code_verifier = c.code_verifier,
    client_id = c.client_id,
    oauth_state = c.oauth_state
FROM public.mcp_credentials c
WHERE s.user_id = c.user_id AND s.session_id = c.session_id;

-- Drop the now-redundant credentials table and its objects
DROP TRIGGER IF EXISTS trg_mcp_credentials_updated_at ON public.mcp_credentials;
DROP INDEX IF EXISTS idx_mcp_credentials_user_session;
DROP TABLE IF EXISTS public.mcp_credentials;