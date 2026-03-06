from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from fastapi import HTTPException, WebSocket, status


logger = logging.getLogger("mcp_remote_server.connection_manager")


@dataclass
class ConnectedAgent:
    subject: str
    owner_id: str
    websocket: WebSocket
    capabilities: set[str]
    pending: dict[str, asyncio.Future[dict[str, Any]]] = field(default_factory=dict)


class ConnectionManager:
    def __init__(self) -> None:
        self._subjects: dict[str, ConnectedAgent] = {}
        self._subscribers: dict[str, set[asyncio.Queue[dict[str, Any]]]] = {}
        self._lock = asyncio.Lock()

    @staticmethod
    def _ts() -> str:
        return datetime.now(timezone.utc).isoformat()

    def _connected_subjects_details_unlocked(self, owner_id: str | None = None) -> list[dict[str, Any]]:
        return [
            {
                "subject": subject,
                "capabilities": sorted(agent.capabilities),
            }
            for subject, agent in self._subjects.items()
            if owner_id is None or agent.owner_id == owner_id
        ]

    def _broadcast_agents_updated_unlocked(self, reason: str, subject: str, owner_id: str) -> None:
        event = {
            "type": "agents_updated",
            "reason": reason,
            "subject": subject,
            "timestamp": self._ts(),
            "agents": self._connected_subjects_details_unlocked(owner_id=owner_id),
        }
        stale: list[asyncio.Queue[dict[str, Any]]] = []
        for queue in self._subscribers.get(owner_id, set()):
            try:
                queue.put_nowait(event)
            except asyncio.QueueFull:
                stale.append(queue)
        for queue in stale:
            self._subscribers.get(owner_id, set()).discard(queue)

    async def register(self, subject: str, owner_id: str, websocket: WebSocket, capabilities: set[str]) -> None:
        async with self._lock:
            existing = self._subjects.get(subject)
            if existing is not None:
                await existing.websocket.close(code=1012, reason="superseded")
            self._subjects[subject] = ConnectedAgent(
                subject=subject,
                owner_id=owner_id,
                websocket=websocket,
                capabilities=capabilities,
            )
            logger.info(
                "agent_registered",
                extra={"subject": subject, "capabilities": sorted(capabilities)},
            )
            self._broadcast_agents_updated_unlocked(reason="registered", subject=subject, owner_id=owner_id)

    async def unregister(self, subject: str, websocket: WebSocket | None = None) -> None:
        async with self._lock:
            agent = self._subjects.get(subject)
            if agent is None:
                return
            if websocket is not None and agent.websocket is not websocket:
                return

            for future in agent.pending.values():
                if not future.done():
                    future.set_exception(
                        HTTPException(
                            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                            detail="Agent disconnected",
                        )
                    )
            self._subjects.pop(subject, None)
            logger.info("agent_unregistered", extra={"subject": subject})
            self._broadcast_agents_updated_unlocked(reason="unregistered", subject=subject, owner_id=agent.owner_id)

    async def handle_result(self, subject: str, request_id: str, result: dict[str, Any]) -> None:
        async with self._lock:
            agent = self._subjects.get(subject)
            if agent is None:
                logger.warning("result_for_unknown_agent", extra={"subject": subject, "request_id": request_id})
                return
            future = agent.pending.pop(request_id, None)
            if future is None:
                logger.warning("orphan_result", extra={"subject": subject, "request_id": request_id})
                return
            if not future.done():
                future.set_result(result)

    async def invoke(
        self,
        subject: str,
        mcp_server: str,
        payload: dict[str, Any],
        request_id: str,
        timeout_seconds: float,
        owner_id: str | None = None,
    ) -> dict[str, Any]:
        async with self._lock:
            agent = self._subjects.get(subject)
            if agent is None:
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Agent not connected")
            if owner_id is not None and agent.owner_id != owner_id:
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Agent not connected")
            if mcp_server not in agent.capabilities:
                raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="MCP server not allowed for agent")

            loop = asyncio.get_running_loop()
            future: asyncio.Future[dict[str, Any]] = loop.create_future()
            agent.pending[request_id] = future
            websocket = agent.websocket

        invoke_message = {
            "type": "invoke",
            "request_id": request_id,
            "mcp_server": mcp_server,
            "payload": payload,
        }
        try:
            await websocket.send_text(json.dumps(invoke_message))
        except Exception as exc:
            async with self._lock:
                pending = self._subjects.get(subject)
                if pending is not None:
                    pending.pending.pop(request_id, None)
            raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Failed to reach agent") from exc

        try:
            return await asyncio.wait_for(future, timeout=timeout_seconds)
        except TimeoutError as exc:
            async with self._lock:
                active = self._subjects.get(subject)
                if active is not None:
                    active.pending.pop(request_id, None)
            logger.warning(
                "invoke_timeout",
                extra={"subject": subject, "mcp_server": mcp_server, "request_id": request_id, "timeout_seconds": timeout_seconds},
            )
            raise HTTPException(status_code=status.HTTP_504_GATEWAY_TIMEOUT, detail="Agent response timed out") from exc

    async def connected_subjects(self, owner_id: str | None = None) -> list[str]:
        async with self._lock:
            return [subject for subject, agent in self._subjects.items() if owner_id is None or agent.owner_id == owner_id]

    async def connected_agents_details(self, owner_id: str | None = None) -> list[dict[str, Any]]:
        async with self._lock:
            return self._connected_subjects_details_unlocked(owner_id=owner_id)

    async def subscribe_agent_events(self, owner_id: str) -> asyncio.Queue[dict[str, Any]]:
        queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=100)
        async with self._lock:
            owner_subs = self._subscribers.setdefault(owner_id, set())
            owner_subs.add(queue)
            queue.put_nowait(
                {
                    "type": "agents_snapshot",
                    "timestamp": self._ts(),
                    "agents": self._connected_subjects_details_unlocked(owner_id=owner_id),
                }
            )
        return queue

    async def unsubscribe_agent_events(self, owner_id: str, queue: asyncio.Queue[dict[str, Any]]) -> None:
        async with self._lock:
            owner_subs = self._subscribers.get(owner_id)
            if owner_subs is None:
                return
            owner_subs.discard(queue)
            if not owner_subs:
                self._subscribers.pop(owner_id, None)
