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
    agent_id: str
    websocket: WebSocket
    capabilities: set[str]
    pending: dict[str, asyncio.Future[dict[str, Any]]] = field(default_factory=dict)


class ConnectionManager:
    def __init__(self) -> None:
        self._agents: dict[str, ConnectedAgent] = {}
        self._subscribers: set[asyncio.Queue[dict[str, Any]]] = set()
        self._lock = asyncio.Lock()

    @staticmethod
    def _ts() -> str:
        return datetime.now(timezone.utc).isoformat()

    def _connected_agents_details_unlocked(self) -> list[dict[str, Any]]:
        return [
            {
                "agent_id": agent_id,
                "capabilities": sorted(agent.capabilities),
            }
            for agent_id, agent in self._agents.items()
        ]

    def _broadcast_agents_updated_unlocked(self, reason: str, agent_id: str) -> None:
        event = {
            "type": "agents_updated",
            "reason": reason,
            "agent_id": agent_id,
            "timestamp": self._ts(),
            "agents": self._connected_agents_details_unlocked(),
        }
        stale: list[asyncio.Queue[dict[str, Any]]] = []
        for queue in self._subscribers:
            try:
                queue.put_nowait(event)
            except asyncio.QueueFull:
                stale.append(queue)
        for queue in stale:
            self._subscribers.discard(queue)

    async def register(self, agent_id: str, websocket: WebSocket, capabilities: set[str]) -> None:
        async with self._lock:
            existing = self._agents.get(agent_id)
            if existing is not None:
                await existing.websocket.close(code=1012, reason="superseded")
            self._agents[agent_id] = ConnectedAgent(
                agent_id=agent_id,
                websocket=websocket,
                capabilities=capabilities,
            )
            logger.info(
                "agent_registered",
                extra={"agent_id": agent_id, "capabilities": sorted(capabilities)},
            )
            self._broadcast_agents_updated_unlocked(reason="registered", agent_id=agent_id)

    async def unregister(self, agent_id: str, websocket: WebSocket | None = None) -> None:
        async with self._lock:
            agent = self._agents.get(agent_id)
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
            self._agents.pop(agent_id, None)
            logger.info("agent_unregistered", extra={"agent_id": agent_id})
            self._broadcast_agents_updated_unlocked(reason="unregistered", agent_id=agent_id)

    async def handle_result(self, agent_id: str, request_id: str, result: dict[str, Any]) -> None:
        async with self._lock:
            agent = self._agents.get(agent_id)
            if agent is None:
                logger.warning("result_for_unknown_agent", extra={"agent_id": agent_id, "request_id": request_id})
                return
            future = agent.pending.pop(request_id, None)
            if future is None:
                logger.warning("orphan_result", extra={"agent_id": agent_id, "request_id": request_id})
                return
            if not future.done():
                future.set_result(result)

    async def invoke(
        self,
        agent_id: str,
        mcp_server: str,
        payload: dict[str, Any],
        request_id: str,
        timeout_seconds: float,
    ) -> dict[str, Any]:
        async with self._lock:
            agent = self._agents.get(agent_id)
            if agent is None:
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
                pending = self._agents.get(agent_id)
                if pending is not None:
                    pending.pending.pop(request_id, None)
            raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Failed to reach agent") from exc

        try:
            return await asyncio.wait_for(future, timeout=timeout_seconds)
        except TimeoutError as exc:
            async with self._lock:
                active = self._agents.get(agent_id)
                if active is not None:
                    active.pending.pop(request_id, None)
            raise HTTPException(status_code=status.HTTP_504_GATEWAY_TIMEOUT, detail="Agent response timed out") from exc

    async def connected_agent_ids(self) -> list[str]:
        async with self._lock:
            return list(self._agents.keys())

    async def connected_agents_details(self) -> list[dict[str, Any]]:
        async with self._lock:
            return self._connected_agents_details_unlocked()

    async def subscribe_agent_events(self) -> asyncio.Queue[dict[str, Any]]:
        queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=100)
        async with self._lock:
            self._subscribers.add(queue)
            queue.put_nowait(
                {
                    "type": "agents_snapshot",
                    "timestamp": self._ts(),
                    "agents": self._connected_agents_details_unlocked(),
                }
            )
        return queue

    async def unsubscribe_agent_events(self, queue: asyncio.Queue[dict[str, Any]]) -> None:
        async with self._lock:
            self._subscribers.discard(queue)
