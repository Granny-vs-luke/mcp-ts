ALTER TABLE public.mcp_sessions
ADD COLUMN IF NOT EXISTS tool_policy jsonb NOT NULL DEFAULT '{"mode":"all","toolIds":[]}'::jsonb;

UPDATE public.mcp_sessions
SET tool_policy = '{"mode":"all","toolIds":[]}'::jsonb
WHERE tool_policy IS NULL;

