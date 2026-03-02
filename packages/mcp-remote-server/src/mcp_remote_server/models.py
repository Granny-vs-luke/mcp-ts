from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


class RegisterMessage(BaseModel):
    type: Literal["register"]
    agent_id: str = Field(min_length=1)
    capabilities: list[str] = Field(default_factory=list)


class ResultMessage(BaseModel):
    type: Literal["result"]
    request_id: str
    result: dict[str, Any] = Field(default_factory=dict)


class MCPInvokeRequest(BaseModel):
    payload: dict[str, Any] = Field(default_factory=dict)
