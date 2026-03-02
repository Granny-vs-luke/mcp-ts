from __future__ import annotations

import os
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

import jwt
from fastapi import Depends, HTTPException, WebSocket, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer


@dataclass
class AuthContext:
    subject: str
    role: str
    capabilities: set[str]
    raw_claims: dict[str, Any]


class JWTAuthenticator:
    def __init__(self) -> None:
        secret = os.getenv("JWT_SECRET")
        algorithm = os.getenv("JWT_ALGORITHM", "HS256")
        if not secret:
            raise RuntimeError("JWT_SECRET must be set")
        self._secret = secret
        self._algorithm = algorithm

    def _decode(self, token: str) -> dict[str, Any]:
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

    def _to_context(self, claims: dict[str, Any]) -> AuthContext:
        subject = str(claims.get("sub", ""))
        role = str(claims.get("role", ""))
        capabilities = set(map(str, claims.get("capabilities", [])))
        if not subject or not role:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Malformed token")
        return AuthContext(subject=subject, role=role, capabilities=capabilities, raw_claims=claims)

    async def websocket_auth(self, websocket: WebSocket) -> AuthContext:
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
        if credentials is None:
            return None
        claims = self._decode(credentials.credentials)
        context = self._to_context(claims)
        if context.role != "agent":
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Agent role required")
        return context
