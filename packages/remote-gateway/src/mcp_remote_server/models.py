from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


class RegisterMessage(BaseModel):
    type: Literal["register"]
    subject: str = Field(min_length=1)
    capabilities: list[str] = Field(default_factory=list)


class ResultMessage(BaseModel):
    type: Literal["result"]
    request_id: str
    result: dict[str, Any] = Field(default_factory=dict)


class MCPInvokeRequest(BaseModel):
    payload: dict[str, Any] = Field(default_factory=dict)


class IssueTokenRequest(BaseModel):
    subject: str = Field(min_length=1, max_length=128)
    expiry_minutes: int = Field(default=60, ge=1, le=1440)
    capabilities: list[str] = Field(default_factory=lambda: ["*"])


class RevokeTokenRequest(BaseModel):
    token: str = Field(min_length=1)


class OAuthStartRequest(BaseModel):
    subject: str = Field(default="", max_length=128)
    expiry_minutes: int = Field(default=60, ge=1, le=1440)
    capabilities: list[str] = Field(default_factory=lambda: ["*"])
    redirect_uri: str = Field(default="", max_length=1024)


class OAuthCompleteRequest(BaseModel):
    session_id: str = Field(min_length=1, max_length=512)
    code: str = Field(min_length=1, max_length=4096)


class OAuthRefreshRequest(BaseModel):
    refresh_token: str = Field(min_length=1, max_length=4096)
    expiry_minutes: int | None = Field(default=None, ge=1, le=1440)


class OAuthLogoutRequest(BaseModel):
    refresh_token: str = Field(min_length=1, max_length=4096)
