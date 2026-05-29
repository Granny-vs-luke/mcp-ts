ALTER TABLE public.mcp_sessions
ADD COLUMN IF NOT EXISTS auth_url TEXT;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'mcp_sessions_user_session_unique'
          AND conrelid = 'public.mcp_sessions'::regclass
    ) THEN
        ALTER TABLE public.mcp_sessions
        ADD CONSTRAINT mcp_sessions_user_session_unique UNIQUE (user_id, session_id);
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.mcp_credentials (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    client_information JSONB,
    tokens JSONB,
    code_verifier TEXT,
    client_id TEXT,
    oauth_state JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT mcp_credentials_session_fk
        FOREIGN KEY (user_id, session_id)
        REFERENCES public.mcp_sessions(user_id, session_id)
        ON DELETE CASCADE,
    CONSTRAINT mcp_credentials_user_session_unique
        UNIQUE (user_id, session_id)
);

CREATE INDEX IF NOT EXISTS idx_mcp_credentials_user_session
ON public.mcp_credentials(user_id, session_id);

INSERT INTO public.mcp_credentials (
    session_id,
    user_id,
    client_information,
    tokens,
    code_verifier,
    client_id,
    oauth_state,
    created_at,
    updated_at
)
SELECT
    session_id,
    user_id,
    client_information,
    tokens,
    code_verifier,
    client_id,
    oauth_state,
    now(),
    now()
FROM public.mcp_sessions
WHERE client_information IS NOT NULL
   OR tokens IS NOT NULL
   OR code_verifier IS NOT NULL
   OR client_id IS NOT NULL
   OR oauth_state IS NOT NULL
ON CONFLICT (user_id, session_id) DO UPDATE
SET client_information = EXCLUDED.client_information,
    tokens = EXCLUDED.tokens,
    code_verifier = EXCLUDED.code_verifier,
    client_id = EXCLUDED.client_id,
    oauth_state = EXCLUDED.oauth_state,
    updated_at = now();

DROP TRIGGER IF EXISTS trg_mcp_credentials_updated_at ON public.mcp_credentials;
CREATE TRIGGER trg_mcp_credentials_updated_at
BEFORE UPDATE ON public.mcp_credentials
FOR EACH ROW
EXECUTE FUNCTION public.set_current_timestamp_updated_at();

ALTER TABLE public.mcp_credentials ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view their own credentials" ON public.mcp_credentials;
CREATE POLICY "Users can view their own credentials"
ON public.mcp_credentials
FOR SELECT
TO authenticated
USING (auth.uid()::text = user_id);

DROP POLICY IF EXISTS "Users can insert their own credentials" ON public.mcp_credentials;
CREATE POLICY "Users can insert their own credentials"
ON public.mcp_credentials
FOR INSERT
TO authenticated
WITH CHECK (auth.uid()::text = user_id);

DROP POLICY IF EXISTS "Users can update their own credentials" ON public.mcp_credentials;
CREATE POLICY "Users can update their own credentials"
ON public.mcp_credentials
FOR UPDATE
TO authenticated
USING (auth.uid()::text = user_id)
WITH CHECK (auth.uid()::text = user_id);

DROP POLICY IF EXISTS "Users can delete their own credentials" ON public.mcp_credentials;
CREATE POLICY "Users can delete their own credentials"
ON public.mcp_credentials
FOR DELETE
TO authenticated
USING (auth.uid()::text = user_id);

ALTER TABLE public.mcp_sessions
DROP COLUMN IF EXISTS client_information,
DROP COLUMN IF EXISTS tokens,
DROP COLUMN IF EXISTS code_verifier,
DROP COLUMN IF EXISTS client_id,
DROP COLUMN IF EXISTS oauth_state;
