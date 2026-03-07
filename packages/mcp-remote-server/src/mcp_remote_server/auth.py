from __future__ import annotations

import asyncio
import hashlib
import os
import secrets
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

import jwt
from fastapi import Depends, HTTPException, WebSocket, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer


@dataclass
class AuthContext:
    """Normalized auth claims used across HTTP and WebSocket handlers."""
    subject: str
    role: str
    capabilities: set[str]
    raw_claims: dict[str, Any]


class JWTAuthenticator:
    """Core JWT validation/issuance utility for remote bridge authorization."""

    def __init__(self) -> None:
        secret = os.getenv("JWT_SECRET")
        algorithm = os.getenv("JWT_ALGORITHM", "HS256")
        if not secret:
            raise RuntimeError("JWT_SECRET must be set")
        self._secret = secret
        self._algorithm = algorithm

    def _decode(self, token: str) -> dict[str, Any]:
        """Validate signature/revocation/expiry and return claims."""
        if self.is_revoked(token):
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Token revoked")
        try:
            claims = jwt.decode(token, self._secret, algorithms=[self._algorithm])
        except jwt.InvalidTokenError as exc:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token") from exc

        exp = claims.get("exp")
        if exp is not None:
            now = datetime.now(UTC).timestamp()
            if now >= float(exp):
                raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Token expired")
        return claims

    @staticmethod
    def _token_digest(token: str) -> str:
        return hashlib.sha256(token.encode("utf-8")).hexdigest()

    _revoked_token_digests: set[str] = set()

    def is_revoked(self, token: str) -> bool:
        return self._token_digest(token) in self._revoked_token_digests

    def revoke_token(self, token: str) -> None:
        digest = self._token_digest(token)
        if digest in self._revoked_token_digests:
            return
        try:
            jwt.decode(
                token,
                self._secret,
                algorithms=[self._algorithm],
                options={"verify_exp": False},
            )
        except jwt.InvalidTokenError as exc:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token") from exc
        self._revoked_token_digests.add(digest)

    def issue_agent_token(
        self,
        subject: str,
        expiry_minutes: int,
        capabilities: list[str] | None = None,
    ) -> str:
        safe_subject = subject.strip()
        if not safe_subject:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="subject is required")

        minutes = max(1, min(1440, int(expiry_minutes)))
        payload = {
            "sub": safe_subject,
            "role": "agent",
            "capabilities": capabilities if capabilities is not None else ["*"],
            "exp": int(datetime.now(UTC).timestamp()) + minutes * 60,
        }
        return str(jwt.encode(payload, self._secret, algorithm=self._algorithm))

    def _to_context(self, claims: dict[str, Any]) -> AuthContext:
        subject = str(claims.get("sub", ""))
        role = str(claims.get("role", ""))
        capabilities = set(map(str, claims.get("capabilities", [])))
        if not subject or not role:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Malformed token")
        return AuthContext(subject=subject, role=role, capabilities=capabilities, raw_claims=claims)

    async def websocket_auth(self, websocket: WebSocket) -> AuthContext:
        """Authenticate incoming agent WebSocket connections."""
        auth_header = websocket.headers.get("authorization")
        if not auth_header:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing authorization header")

        parts = auth_header.split(" ", 1)
        if len(parts) != 2 or parts[0].lower() != "bearer":
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid authorization header")

        claims = self._decode(parts[1])
        context = self._to_context(claims)
        if context.role != "agent":
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Agent role required")
        return context

    async def http_auth(self, credentials: HTTPAuthorizationCredentials | None = Depends(HTTPBearer(auto_error=False))) -> AuthContext:
        """Authenticate HTTP routes that require a bridge token."""
        if credentials is None:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing bearer token")
        claims = self._decode(credentials.credentials)
        context = self._to_context(claims)
        if context.role != "agent":
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Agent role required")
        return context

    async def optional_http_auth(
        self,
        credentials: HTTPAuthorizationCredentials | None = Depends(HTTPBearer(auto_error=False)),
    ) -> AuthContext | None:
        """Authenticate HTTP routes that can optionally accept bearer auth."""
        if credentials is None:
            return None
        claims = self._decode(credentials.credentials)
        context = self._to_context(claims)
        if context.role != "agent":
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Agent role required")
        return context


@dataclass
class JWTFallbackConfig:
    """Feature flag wrapper for manual JWT issue/revoke fallback mode."""
    enabled: bool

    @classmethod
    def from_env(cls) -> "JWTFallbackConfig":
        raw = os.getenv("JWT_FALLBACK_ENABLED", "true").strip().lower()
        enabled = raw in {"1", "true", "yes", "on"}
        return cls(enabled=enabled)


class JWTFallbackService:
    """Manual token issue/revoke service used when OAuth is not preferred/available."""

    def __init__(self, authenticator: JWTAuthenticator) -> None:
        self._authenticator = authenticator
        self._config = JWTFallbackConfig.from_env()

    def issue_token(self, *, subject: str, expiry_minutes: int, capabilities: list[str]) -> dict[str, object]:
        if not self._config.enabled:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="JWT fallback auth is disabled",
            )
        token = self._authenticator.issue_agent_token(
            subject=subject,
            expiry_minutes=expiry_minutes,
            capabilities=capabilities,
        )
        return {
            "token": token,
            "subject": subject,
            "expiry_minutes": expiry_minutes,
            "capabilities": capabilities,
            "auth_mode": "jwt_fallback",
        }

    def issue_token_string(self, *, subject: str, expiry_minutes: int, capabilities: list[str]) -> str:
        if not self._config.enabled:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="JWT fallback auth is disabled",
            )
        return self._authenticator.issue_agent_token(
            subject=subject,
            expiry_minutes=expiry_minutes,
            capabilities=capabilities,
        )

    def revoke_token(self, token: str) -> dict[str, bool]:
        if not self._config.enabled:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="JWT fallback auth is disabled",
            )
        self._authenticator.revoke_token(token)
        return {"revoked": True}


@dataclass
class RefreshSession:
    """Server-side OAuth-derived refresh session metadata."""
    subject: str
    email: str
    capabilities: list[str]
    bridge_expiry_minutes: int
    expires_at: float


class RefreshSessionStore:
    """In-memory refresh token store for silent bridge JWT renewal."""

    def __init__(self) -> None:
        ttl_days_raw = os.getenv("OAUTH_REFRESH_TTL_DAYS", "30").strip()
        try:
            ttl_days = int(ttl_days_raw)
        except ValueError:
            ttl_days = 30
        self._ttl_seconds = max(1, min(180, ttl_days)) * 24 * 60 * 60
        self._sessions: dict[str, RefreshSession] = {}
        self._revoked: set[str] = set()
        self._lock = asyncio.Lock()

    @staticmethod
    def _digest(token: str) -> str:
        return hashlib.sha256(token.encode("utf-8")).hexdigest()

    async def _prune(self) -> None:
        now = time.time()
        stale = [digest for digest, session in self._sessions.items() if session.expires_at < now]
        for digest in stale:
            self._sessions.pop(digest, None)
            self._revoked.discard(digest)

    async def issue(
        self,
        *,
        subject: str,
        email: str,
        capabilities: list[str],
        bridge_expiry_minutes: int,
    ) -> dict[str, object]:
        """Create and persist a refresh token session after successful OAuth login."""
        token = secrets.token_urlsafe(48)
        digest = self._digest(token)
        now = time.time()
        expires_at = now + self._ttl_seconds
        session = RefreshSession(
            subject=subject.strip(),
            email=email.strip().lower(),
            capabilities=[str(item) for item in capabilities],
            bridge_expiry_minutes=max(1, int(bridge_expiry_minutes)),
            expires_at=expires_at,
        )
        async with self._lock:
            await self._prune()
            self._sessions[digest] = session
            self._revoked.discard(digest)
        return {"refresh_token": token, "refresh_expires_at": int(expires_at)}

    async def refresh(
        self,
        *,
        refresh_token: str,
        issue_bridge_token: Any,
        expiry_minutes: int | None = None,
    ) -> dict[str, object]:
        """Exchange a valid refresh token for a new short-lived bridge JWT."""
        digest = self._digest(refresh_token.strip())
        async with self._lock:
            await self._prune()
            if digest in self._revoked:
                raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Refresh token revoked")
            session = self._sessions.get(digest)
            if session is None:
                raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid refresh token")
            minutes = max(1, int(expiry_minutes)) if expiry_minutes is not None else session.bridge_expiry_minutes
            token = issue_bridge_token(
                subject=session.subject,
                expiry_minutes=minutes,
                capabilities=session.capabilities,
            )
            return {
                "token": token,
                "subject": session.subject,
                "email": session.email,
                "capabilities": session.capabilities,
                "expiry_minutes": minutes,
            }

    async def revoke(self, refresh_token: str) -> bool:
        """Invalidate a refresh token and mark it revoked for reuse protection."""
        digest = self._digest(refresh_token.strip())
        async with self._lock:
            await self._prune()
            existed = digest in self._sessions
            self._sessions.pop(digest, None)
            self._revoked.add(digest)
        return existed
