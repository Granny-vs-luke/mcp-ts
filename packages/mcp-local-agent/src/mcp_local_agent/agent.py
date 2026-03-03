from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
import signal
from contextlib import AsyncExitStack
from dataclasses import asdict, is_dataclass
from typing import Any
from urllib.parse import urlparse

import httpx
import jwt
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed

from .config import AgentConfig, load_config


def configure_logging() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s", force=True)


logger = logging.getLogger("mcp_local_agent")
DEFAULT_PROTOCOL_VERSION = os.getenv("MCP_PROTOCOL_VERSION", "2025-11-25")


def _console(msg: str) -> None:
    print(msg, flush=True)


def _to_jsonable(value: Any) -> Any:
    if hasattr(value, "model_dump"):
        try:
            return _to_jsonable(value.model_dump(mode="json", exclude_none=True))
        except TypeError:
            return _to_jsonable(value.model_dump(mode="json"))
    if is_dataclass(value):
        return _to_jsonable(asdict(value))
    if isinstance(value, dict):
        return {str(k): _to_jsonable(v) for k, v in value.items() if v is not None}
    if isinstance(value, (list, tuple, set)):
        return [_to_jsonable(v) for v in value]
    if hasattr(value, "__dict__") and not isinstance(value, (str, bytes, bytearray)):
        return _to_jsonable(vars(value))
    return value


def _normalize_initialize_result(result: Any, requested_protocol: str | None = None) -> dict[str, Any]:
    payload = _to_jsonable(result)
    payload = payload if isinstance(payload, dict) else {}

    server_info = payload.get("serverInfo") if isinstance(payload.get("serverInfo"), dict) else {}
    capabilities = payload.get("capabilities") if isinstance(payload.get("capabilities"), dict) else {}

    payload["protocolVersion"] = str(requested_protocol or payload.get("protocolVersion") or DEFAULT_PROTOCOL_VERSION)
    payload["capabilities"] = capabilities
    payload["serverInfo"] = {
        "name": str(server_info.get("name") or "local-bridge-proxy"),
        "version": str(server_info.get("version") or "1.0.0"),
    }
    payload["instructions"] = str(payload.get("instructions") or "")
    return payload


class ManagedMCPServer:
    def __init__(self, name: str, server_cfg: dict[str, Any]) -> None:
        self.name = name
        self.server_cfg = server_cfg
        self.exit_stack = AsyncExitStack()
        self.session: ClientSession | None = None
        self._initialize_result: dict[str, Any] = {}

    async def start(self) -> None:
        command = str(self.server_cfg.get("command", "")).strip()
        if not command:
            raise RuntimeError(f"mcpServers.{self.name}.command is required")

        resolved_command = shutil.which(command) if command in {"npx", "npm", "pnpm", "yarn"} else command
        if resolved_command is None:
            raise RuntimeError(f"Unable to resolve command for mcpServers.{self.name}: {command}")

        args = [str(item) for item in self.server_cfg.get("args", [])]
        env = {**os.environ, **{str(k): str(v) for k, v in self.server_cfg.get("env", {}).items()}}

        server_params = StdioServerParameters(command=resolved_command, args=args, env=env)
        transport = await self.exit_stack.enter_async_context(stdio_client(server_params))
        read, write = transport
        session = await self.exit_stack.enter_async_context(ClientSession(read, write))
        self._initialize_result = _normalize_initialize_result(await session.initialize())
        self.session = session

    async def close(self) -> None:
        await self.exit_stack.aclose()
        self.session = None
        self._initialize_result = {}

    async def handle_jsonrpc(self, payload: dict[str, Any]) -> dict[str, Any]:
        if self.session is None:
            raise RuntimeError(f"MCP server '{self.name}' is not initialized")

        request_id = payload.get("id")
        method = str(payload.get("method", ""))
        params = payload.get("params", {}) if isinstance(payload.get("params", {}), dict) else {}
        requested_protocol = str(params.get("protocolVersion", "")).strip() or None

        try:
            if method == "initialize":
                result = _normalize_initialize_result(self._initialize_result, requested_protocol)
            elif method in {"tools/list", "list_tools"}:
                result = await self.session.list_tools()
            elif method in {"tools/call", "call_tool"}:
                tool_name = str(params.get("name", ""))
                arguments = params.get("arguments", {}) if isinstance(params.get("arguments", {}), dict) else {}
                result = await self.session.call_tool(tool_name, arguments)
            elif method.startswith("notifications/"):
                return {}
            else:
                raise RuntimeError(f"Unsupported MCP method for local bridge: {method}")
        except Exception as exc:
            if request_id is None:
                return {"ok": False, "error": str(exc)}
            return {
                "jsonrpc": "2.0",
                "id": request_id,
                "error": {"code": -32000, "message": str(exc)},
            }

        response_payload = _to_jsonable(result)
        if request_id is None:
            return response_payload if isinstance(response_payload, dict) else {"result": response_payload}
        return {"jsonrpc": "2.0", "id": request_id, "result": response_payload}


class LocalBridgeAgent:
    def __init__(self, config: AgentConfig) -> None:
        self.config = config
        self._stop_event = asyncio.Event()
        self._mcp_servers: dict[str, ManagedMCPServer] = {}
        self._generic_mcp_endpoint: str | None = None

    async def run(self) -> None:
        await self._start_mcp_servers_if_configured()
        _console(f"🚀 [bridge] starting: websocket={self.config.websocket_url} agent_id={self.config.agent_id}")
        backoff = self.config.reconnect_initial_delay_seconds
        while not self._stop_event.is_set():
            try:
                _console("🔌 [bridge] attempting websocket connection")
                await self._session()
                backoff = self.config.reconnect_initial_delay_seconds
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                logger.exception("agent session error")
                _console(f"⚠️ [bridge] reconnecting in {backoff:.1f}s due to error: {exc}")
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, self.config.reconnect_max_delay_seconds)

    async def stop(self) -> None:
        self._stop_event.set()
        await self._stop_mcp_servers()

    async def _session(self) -> None:
        headers = {"Authorization": f"Bearer {self.config.jwt_token}"}
        async with connect(self.config.websocket_url, additional_headers=headers, ping_interval=20, ping_timeout=20) as websocket:
            announced_servers = self._announced_mcp_servers()
            register_msg = {"type": "register", "agent_id": self.config.agent_id, "capabilities": announced_servers}
            await websocket.send(json.dumps(register_msg))
            _console(f"✅ [bridge] connected and registered mcp_servers={','.join(announced_servers)}")

            async for raw in websocket:
                if self._stop_event.is_set():
                    break
                await self._handle_message(websocket, raw)

    def _announced_mcp_servers(self) -> list[str]:
        if self.config.mcp_servers:
            return [str(name) for name in self.config.mcp_servers.keys()]
        # Fallback for endpoint-only configs; don't advertise wildcard as server name.
        servers = [str(item) for item in self.config.capabilities if str(item) != "*"]
        if servers:
            return servers
        return [str(name) for name in self.config.local_capability_endpoints.keys()]

    async def _start_mcp_servers_if_configured(self) -> None:
        servers = self.config.mcp_servers or {}
        if not servers:
            _console("ℹ️ [mcp] no mcpServers configured")
            return

        if os.getenv("START_MCP_SERVERS", "true").strip().lower() in {"0", "false", "no", "off"}:
            _console("ℹ️ [mcp] START_MCP_SERVERS=false; skipping mcpServers startup")
            return

        _console(f"🚀 [mcp] initializing {len(servers)} MCP server session(s)")
        for name, cfg in servers.items():
            if not isinstance(cfg, dict):
                _console(f"⚠️ [mcp] skipping '{name}' (invalid config object)")
                continue
            managed = ManagedMCPServer(name, cfg)
            try:
                await managed.start()
                self._mcp_servers[name] = managed
                _console(f"✅ [mcp] initialized '{name}' via stdio MCP client")
            except Exception as exc:
                _console(f"⚠️ [mcp] failed to initialize '{name}': {exc}")

    async def _stop_mcp_servers(self) -> None:
        for name, managed in list(self._mcp_servers.items()):
            try:
                await managed.close()
            except Exception as exc:
                logger.warning("error while closing MCP server '%s': %s", name, exc)
        if self._mcp_servers:
            _console("ℹ️ [mcp] all managed MCP sessions closed")
        self._mcp_servers.clear()

    async def _handle_message(self, websocket: Any, raw: str) -> None:
        try:
            message = json.loads(raw)
        except json.JSONDecodeError:
            logger.warning("invalid json message")
            return

        if message.get("type") != "invoke":
            logger.warning("unsupported message type: %s", message.get("type"))
            return

        request_id = str(message.get("request_id", ""))
        mcp_server = str(message.get("mcp_server", message.get("capability", "")))
        payload = message.get("payload", {})
        logger.info("invoke received request_id=%s mcp_server=%s", request_id, mcp_server)

        result = await self._invoke_local_mcp_server(mcp_server, payload)
        await websocket.send(json.dumps({"type": "result", "request_id": request_id, "result": result}))
        logger.info("result sent request_id=%s mcp_server=%s", request_id, mcp_server)

    async def _invoke_local_mcp_server(self, mcp_server: str, payload: dict[str, Any]) -> dict[str, Any]:
        managed = self._mcp_servers.get(mcp_server)
        if managed is not None:
            if isinstance(payload, dict):
                return await managed.handle_jsonrpc(payload)
            return {"ok": False, "error": "Invalid payload format for MCP request"}

        endpoint = self.config.local_capability_endpoints.get(mcp_server)
        if endpoint:
            return await self._invoke_http_endpoint(endpoint, payload)

        endpoint = await self._resolve_dynamic_endpoint(mcp_server)
        if endpoint:
            return await self._invoke_http_endpoint(endpoint, {"mcp_server": mcp_server, "payload": payload})

        return {"ok": False, "error": f"Unknown mcp_server: {mcp_server}"}

    async def _invoke_http_endpoint(self, endpoint: str, payload: dict[str, Any]) -> dict[str, Any]:
        try:
            async with httpx.AsyncClient(timeout=self.config.request_timeout_seconds) as client:
                response = await client.post(endpoint, json=payload)
                response.raise_for_status()
                data = response.json()
                return data if isinstance(data, dict) else {"data": data}
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    async def _resolve_dynamic_endpoint(self, mcp_server: str) -> str | None:
        if not self.config.auto_discover_local_mcp:
            return None
        if self._generic_mcp_endpoint:
            return self._generic_mcp_endpoint

        for candidate in self._candidate_urls():
            try:
                async with httpx.AsyncClient(timeout=self.config.request_timeout_seconds) as client:
                    response = await client.post(candidate, json={"mcp_server": mcp_server, "payload": {"method": "ping"}})
                    if response.status_code < 500:
                        self._generic_mcp_endpoint = candidate
                        return candidate
            except Exception:
                continue
        return None

    def _candidate_urls(self) -> list[str]:
        env_candidates = self.config.discovery_candidates or []
        configured_endpoints = list(self.config.local_capability_endpoints.values())
        seen: set[str] = set()
        candidates: list[str] = []
        for url in [*env_candidates, *configured_endpoints]:
            normalized = str(url).strip()
            if not normalized:
                continue
            parsed = urlparse(normalized)
            if not parsed.scheme or not parsed.netloc:
                continue
            if normalized in seen:
                continue
            seen.add(normalized)
            candidates.append(normalized)
        return candidates


async def _main() -> None:
    configure_logging()
    config = load_config()
    _console(f"✅ [boot] loaded config: agent_id={config.agent_id} websocket={config.websocket_url}")
    _console(f"ℹ️ [boot] mcpServers keys: {list((config.mcp_servers or {}).keys())}")
    try:
        claims = jwt.decode(config.jwt_token, options={"verify_signature": False, "verify_exp": False})
        _console(
            "ℹ️ [boot] jwt summary: sub=%s role=%s mcp_servers=%s"
            % (claims.get("sub", ""), claims.get("role", ""), len(claims.get("capabilities", []) or []))
        )
    except Exception:
        _console("⚠️ [boot] unable to parse AGENT_JWT claims")

    agent = LocalBridgeAgent(config)
    loop = asyncio.get_running_loop()
    shutdown_started = asyncio.Event()

    def _signal_handler() -> None:
        if not shutdown_started.is_set():
            shutdown_started.set()

    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, _signal_handler)
        except NotImplementedError:
            signal.signal(sig, lambda *_: _signal_handler())

    runner = asyncio.create_task(agent.run())
    await shutdown_started.wait()
    await agent.stop()
    runner.cancel()
    try:
        await runner
    except asyncio.CancelledError:
        pass


def cli() -> None:
    try:
        asyncio.run(_main())
    except ConnectionClosed:
        logger.info("connection closed")


if __name__ == "__main__":
    cli()
