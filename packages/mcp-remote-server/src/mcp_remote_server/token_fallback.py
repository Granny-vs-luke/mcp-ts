from __future__ import annotations

import os
from dataclasses import dataclass

from fastapi import HTTPException, status

from .auth import JWTAuthenticator


@dataclass
class JWTFallbackConfig:
    enabled: bool

    @classmethod
    def from_env(cls) -> "JWTFallbackConfig":
        raw = os.getenv("JWT_FALLBACK_ENABLED", "true").strip().lower()
        enabled = raw in {"1", "true", "yes", "on"}
        return cls(enabled=enabled)


class JWTFallbackService:
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

