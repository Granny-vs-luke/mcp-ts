ALTER TABLE public.mcp_sessions
ADD COLUMN IF NOT EXISTS oauth_state JSONB;
