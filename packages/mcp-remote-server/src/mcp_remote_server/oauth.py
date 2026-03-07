from __future__ import annotations

import asyncio
import base64
import hashlib
import logging
import os
import secrets
import time
from dataclasses import dataclass
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

import httpx
import jwt
from fastapi import HTTPException, status

logger = logging.getLogger("mcp_remote_server.oauth")


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _pkce_pair() -> tuple[str, str]:
    verifier = _b64url(secrets.token_bytes(32))
    challenge = _b64url(hashlib.sha256(verifier.encode("ascii")).digest())
    return verifier, challenge


@dataclass
class OAuthSession:
    """Ephemeral PKCE login session tracked between /start and /complete."""
    session_id: str
    code_verifier: str
    subject: str
    expiry_minutes: int
    capabilities: list[str]
    created_at: float
    expires_at: float
    status: str = "pending"
    token: str = ""
    error: str = ""
    email: str = ""
    redirect_uri: str = ""


class SupabaseOAuthManager:
    """Supabase OAuth orchestrator for browser login and code exchange."""

    def __init__(self) -> None:
        self.supabase_url = os.getenv("SUPABASE_URL", "").strip().rstrip("/")
        self.supabase_anon_key = os.getenv("SUPABASE_ANON_KEY", "").strip()
        self.provider = os.getenv("SUPABASE_OAUTH_PROVIDER", "google").strip()
        self.public_base_url = os.getenv("OAUTH_PUBLIC_BASE_URL", "").strip().rstrip("/")
        self.allowed_domains = {
            item.strip().lower()
            for item in os.getenv("OAUTH_ALLOWED_EMAIL_DOMAINS", "").split(",")
            if item.strip()
        }
        self._sessions_by_id: dict[str, OAuthSession] = {}
        self._lock = asyncio.Lock()
        self._jwk_client = None

    @property
    def enabled(self) -> bool:
        return bool(self.supabase_url and self.supabase_anon_key)

    def _jwks_url(self) -> str:
        return f"{self.supabase_url}/auth/v1/.well-known/jwks.json"

    def _callback_url(self, request_base_url: str) -> str:
        base = self.public_base_url or request_base_url.rstrip("/")
        return f"{base}/manage/oauth/callback"

    def _with_session_id(self, redirect_uri: str, session_id: str) -> str:
        parsed = urlparse(redirect_uri)
        query_pairs = [(k, v) for (k, v) in parse_qsl(parsed.query, keep_blank_values=True) if k != "session_id"]
        query_pairs.append(("session_id", session_id))
        rebuilt = parsed._replace(query=urlencode(query_pairs))
        return urlunparse(rebuilt)

    async def _prune_expired(self) -> None:
        now = time.time()
        stale = [sid for sid, session in self._sessions_by_id.items() if session.expires_at < now]
        for sid in stale:
            self._sessions_by_id.pop(sid, None)

    async def start(
        self,
        *,
        request_base_url: str,
        subject: str = "",
        expiry_minutes: int,
        capabilities: list[str],
        redirect_uri: str = "",
    ) -> dict[str, Any]:
        """Create PKCE session and return Supabase authorization URL."""
        if not self.enabled:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Supabase OAuth is not configured on remote server",
            )

        verifier, challenge = _pkce_pair()
        session_id = secrets.token_urlsafe(24)
        now = time.time()
        expires_at = now + 600  # 10 minutes for interactive login completion
        effective_redirect_uri = redirect_uri.strip() or self._callback_url(request_base_url)
        callback_with_session = self._with_session_id(effective_redirect_uri, session_id)
        session = OAuthSession(
            session_id=session_id,
            code_verifier=verifier,
            subject=subject.strip(),
            expiry_minutes=expiry_minutes,
            capabilities=capabilities,
            created_at=now,
            expires_at=expires_at,
            redirect_uri=callback_with_session,
        )
        query = urlencode(
            {
                "provider": self.provider,
                "redirect_to": callback_with_session,
                "code_challenge": challenge,
                "code_challenge_method": "S256",
            }
        )
        auth_url = f"{self.supabase_url}/auth/v1/authorize?{query}"
        logger.info(
            "oauth_start session_id=%s provider=%s supabase_url=%s redirect_to=%s",
            session_id,
            self.provider,
            self.supabase_url,
            callback_with_session,
        )

        async with self._lock:
            await self._prune_expired()
            self._sessions_by_id[session_id] = session

        return {
            "session_id": session_id,
            "auth_url": auth_url,
            "expires_at": int(expires_at),
            "provider": self.provider,
        }

    async def _exchange_code(self, code: str, code_verifier: str) -> str:
        token_url = f"{self.supabase_url}/auth/v1/token"
        params = {"grant_type": "pkce"}
        headers = {
            "apikey": self.supabase_anon_key,
            "Content-Type": "application/json",
        }
        payload = {"auth_code": code, "code_verifier": code_verifier}
        async with httpx.AsyncClient(timeout=20.0) as client:
            response = await client.post(token_url, params=params, json=payload, headers=headers)
            response.raise_for_status()
            body = response.json()
        access_token = str(body.get("access_token", "")).strip()
        if not access_token:
            raise RuntimeError("Supabase token exchange returned no access_token")
        return access_token

    async def _resolve_user_info(self, access_token: str) -> dict[str, str]:
        user_url = f"{self.supabase_url}/auth/v1/user"
        headers = {
            "apikey": self.supabase_anon_key,
            "Authorization": f"Bearer {access_token}",
        }
        async with httpx.AsyncClient(timeout=20.0) as client:
            response = await client.get(user_url, headers=headers)
            response.raise_for_status()
            body = response.json()
        return {
            "id": str(body.get("id", "")).strip(),
            "email": str(body.get("email", "")).strip().lower(),
        }

    def _verify_access_token(self, access_token: str) -> dict[str, Any]:
        if self._jwk_client is None:
            self._jwk_client = jwt.PyJWKClient(self._jwks_url())
        signing_key = self._jwk_client.get_signing_key_from_jwt(access_token)
        claims = jwt.decode(
            access_token,
            key=signing_key.key,
            algorithms=["RS256", "ES256"],
            options={"verify_aud": False},
        )
        return claims if isinstance(claims, dict) else {}

    async def complete(
        self,
        *,
        session_id: str,
        code: str,
        issue_bridge_token: Any,
    ) -> dict[str, Any]:
        """Finalize OAuth code exchange and mint a bridge JWT."""
        async with self._lock:
            await self._prune_expired()
            session = self._sessions_by_id.get(session_id)
            if session is None:
                raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid or expired OAuth session")

        try:
            access_token = await self._exchange_code(code=code, code_verifier=session.code_verifier)
            claims: dict[str, Any] = {}
            try:
                claims = self._verify_access_token(access_token)
            except Exception as exc:
                # Token verification is best-effort here; /auth/v1/user remains the source of truth.
                logger.warning("oauth_access_token_verify_skipped error=%s", exc)
            user_info = await self._resolve_user_info(access_token)
            email = user_info.get("email", "")
            resolved_subject = session.subject.strip()
            if not resolved_subject:
                resolved_subject = (
                    user_info.get("id", "").strip()
                    or str(claims.get("sub", "")).strip()
                    or email
                )
            if not resolved_subject:
                raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Unable to derive subject from OAuth profile")
            if self.allowed_domains:
                domain = email.split("@")[-1] if "@" in email else ""
                if domain.lower() not in self.allowed_domains:
                    raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Email domain is not allowed")

            token = issue_bridge_token(
                subject=resolved_subject,
                expiry_minutes=session.expiry_minutes,
                capabilities=session.capabilities,
            )
            async with self._lock:
                active = self._sessions_by_id.get(session.session_id)
                if active is None:
                    return {
                        "token": token,
                        "subject": resolved_subject,
                        "email": email,
                        "capabilities": session.capabilities,
                        "expiry_minutes": session.expiry_minutes,
                    }
                active.subject = resolved_subject
                active.status = "complete"
                active.token = token
                active.email = email or str(claims.get("email", "")).strip().lower()
            return {
                "token": token,
                "subject": resolved_subject,
                "email": email or str(claims.get("email", "")).strip().lower(),
                "capabilities": session.capabilities,
                "expiry_minutes": session.expiry_minutes,
            }
        except HTTPException as exc:
            async with self._lock:
                active = self._sessions_by_id.get(session.session_id)
                if active is not None:
                    active.status = "failed"
                    active.error = str(exc.detail)
            raise
        except httpx.HTTPStatusError as exc:
            reason = exc.response.text.strip() if exc.response is not None else str(exc)
            detail = f"Supabase OAuth exchange failed: {reason[:300]}"
            async with self._lock:
                active = self._sessions_by_id.get(session.session_id)
                if active is not None:
                    active.status = "failed"
                    active.error = detail
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=detail) from exc
        except Exception as exc:
            async with self._lock:
                active = self._sessions_by_id.get(session.session_id)
                if active is not None:
                    active.status = "failed"
                    active.error = str(exc)
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=f"OAuth completion failed: {exc}",
            ) from exc

    async def fail(self, *, session_id: str, reason: str) -> None:
        async with self._lock:
            session = self._sessions_by_id.get(session_id)
            if session is None:
                return
            session.status = "failed"
            session.error = reason

    async def status(self, session_id: str) -> dict[str, Any]:
        async with self._lock:
            await self._prune_expired()
            session = self._sessions_by_id.get(session_id)
            if session is None:
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="OAuth session not found")

            if session.status == "pending":
                return {"status": "pending"}
            if session.status == "failed":
                return {"status": "failed", "error": session.error}
            if session.status == "complete":
                token = session.token
                subject = session.subject
                email = session.email
                # One-time token retrieval
                self._sessions_by_id.pop(session.session_id, None)
                return {"status": "complete", "token": token, "subject": subject, "email": email}

            return {"status": "failed", "error": "Unknown OAuth session state"}
