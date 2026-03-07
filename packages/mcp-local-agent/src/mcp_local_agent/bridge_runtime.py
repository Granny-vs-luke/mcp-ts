from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
import sys
from contextlib import AsyncExitStack
from dataclasses import asdict, is_dataclass
from typing import Any, Callable
from urllib.parse import urlparse

import httpx
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from websockets.asyncio.client import connect
from websockets.exceptions import InvalidStatus

from .config import AgentConfig, resolve_config_path, save_config_updates

logger = logging.getLogger("mcp_local_agent")
DEFAULT_PROTOCOL_VERSION = os.getenv("MCP_PROTOCOL_VERSION", "2025-11-25")


def _http_base_from_websocket_url(websocket_url: str) -> str:
    ws = websocket_url.strip()
    if ws.startswith("wss://"):
        return "https://" + ws.removeprefix("wss://").removesuffix("/connect")
    if ws.startswith("ws://"):
        return "http://" + ws.removeprefix("ws://").removesuffix("/connect")
    return ws.removesuffix("/connect")


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


def _display_subject(subject: str) -> str:
    value = (subject or "").strip()
    return value[-10:] if len(value) > 10 else value


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
    """Lifecycle wrapper for one managed stdio MCP server process/session."""

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
            return {"jsonrpc": "2.0", "id": request_id, "error": {"code": -32000, "message": str(exc)}}

        response_payload = _to_jsonable(result)
        if request_id is None:
            return response_payload if isinstance(response_payload, dict) else {"result": response_payload}
        return {"jsonrpc": "2.0", "id": request_id, "result": response_payload}


class LocalBridgeAgent:
    """Main runtime bridge: manages MCP servers + WebSocket registration/invocation loop."""

    def __init__(
        self,
        config: AgentConfig,
        *,
        on_log: Callable[[str, str], None] | None = None,
        prompt_for_token: Callable[[], str] | None = None,
        derive_subject: Callable[[str], str] | None = None,
        persist_updates: Callable[[dict[str, str]], None] | None = None,
        refresh_jwt: Callable[[], tuple[str, str] | None] | None = None,
        enable_spinner: bool = True,
        on_registered: Callable[[], None] | None = None,
    ) -> None:
        self.config = config
        self._stop_event = asyncio.Event()
        self._mcp_servers: dict[str, ManagedMCPServer] = {}
        self._generic_mcp_endpoint: str | None = None
        self._send_lock = asyncio.Lock()
        self._inflight_tasks: set[asyncio.Task[None]] = set()
        self._on_log = on_log
        self._prompt_for_token = prompt_for_token
        self._derive_subject = derive_subject
        self._persist_updates = persist_updates
        self._refresh_jwt = refresh_jwt
        self._enable_spinner = enable_spinner
        self._on_registered = on_registered

    def _log(self, tag: str, message: str) -> None:
        if self._on_log is not None:
            self._on_log(tag, message)
            return
        print(f"[{tag}] {message}", flush=True)

    async def run(self) -> None:
        await self._start_mcp_servers_if_configured()
        self._log("bridge", f"starting: websocket={self.config.websocket_url} subject={_display_subject(self.config.subject)}")
        backoff = self.config.reconnect_initial_delay_seconds
        attempt = 0
        try:
            while not self._stop_event.is_set():
                attempt += 1
                try:
                    self._log("bridge", f"connecting websocket (attempt {attempt})")
                    await self._session()
                    backoff = self.config.reconnect_initial_delay_seconds
                except asyncio.CancelledError:
                    raise
                except Exception as exc:
                    logger.exception("agent session error")
                    if self._is_auth_forbidden(exc):
                        recovered = await self._recover_token_after_403()
                        if recovered:
                            backoff = self.config.reconnect_initial_delay_seconds
                            continue
                    self._log("bridge", f"reconnecting in {backoff:.1f}s due to error: {exc}")
                    await asyncio.sleep(backoff)
                    backoff = min(backoff * 2, self.config.reconnect_max_delay_seconds)
        finally:
            await self._stop_mcp_servers()

    async def stop(self) -> None:
        self._stop_event.set()

    async def _session(self) -> None:
        headers = {"Authorization": f"Bearer {self.config.jwt_token}"}
        async with connect(self.config.websocket_url, additional_headers=headers, ping_interval=20, ping_timeout=20) as websocket:
            announced_servers = self._announced_mcp_servers()
            register_msg = {"type": "register", "subject": self.config.subject, "capabilities": announced_servers}
            await websocket.send(json.dumps(register_msg))
            self._log("bridge", f"connected and registered mcp_servers={','.join(announced_servers)}")
            base = _http_base_from_websocket_url(self.config.websocket_url).rstrip("/")
            published = {
                name: {
                    "mcp": f"{base}/{self.config.subject}/{name}/mcp",
                    "sse": f"{base}/{self.config.subject}/{name}/sse",
                    "server_info": f"{base}/manage/{self.config.subject}/{name}/server-info",
                }
                for name in announced_servers
            }
            save_config_updates({"published_endpoints": published}, resolve_config_path())
            for name, urls in published.items():
                self._log("url", f"{name} -> {urls['mcp']}")
            if self._on_registered is not None:
                try:
                    self._on_registered()
                except Exception:
                    pass

            async for raw in websocket:
                if self._stop_event.is_set():
                    break
                task = asyncio.create_task(self._handle_message(websocket, raw))
                self._inflight_tasks.add(task)
                task.add_done_callback(self._inflight_tasks.discard)
        if self._inflight_tasks:
            await asyncio.gather(*list(self._inflight_tasks), return_exceptions=True)

    def _announced_mcp_servers(self) -> list[str]:
        if self.config.mcp_servers:
            return [str(name) for name in self.config.mcp_servers.keys()]
        servers = [str(item) for item in self.config.capabilities if str(item) != "*"]
        if servers:
            return servers
        return [str(name) for name in self.config.local_capability_endpoints.keys()]

    async def _start_mcp_servers_if_configured(self) -> None:
        servers = self.config.mcp_servers or {}
        if not servers:
            self._log("mcp", "no mcpServers configured")
            return
        if os.getenv("START_MCP_SERVERS", "true").strip().lower() in {"0", "false", "no", "off"}:
            self._log("mcp", "START_MCP_SERVERS=false; skipping mcpServers startup")
            return
        total = len(servers)
        self._log("mcp", f"initializing {total} MCP server session(s)")
        for index, (name, cfg) in enumerate(servers.items(), start=1):
            if not isinstance(cfg, dict):
                self._log("mcp", f"[{index}/{total}] skipping '{name}' (invalid config object)")
                continue
            managed = ManagedMCPServer(name, cfg)
            try:
                start_at = asyncio.get_running_loop().time()
                self._log("mcp", f"[{index}/{total}] starting '{name}' ...")
                if self._enable_spinner:
                    await self._run_with_spinner(f"[{index}/{total}] '{name}'", managed.start())
                else:
                    await managed.start()
                self._mcp_servers[name] = managed
                elapsed = asyncio.get_running_loop().time() - start_at
                self._log("mcp", f"[{index}/{total}] ready '{name}' via stdio MCP client ({elapsed:.1f}s)")
            except Exception as exc:
                self._log("mcp", f"[{index}/{total}] failed '{name}': {exc}")

    async def _stop_mcp_servers(self) -> None:
        for name, managed in list(self._mcp_servers.items()):
            try:
                await managed.close()
            except Exception as exc:
                logger.warning("error while closing MCP server '%s': %s", name, exc)
        if self._mcp_servers:
            self._log("mcp", "all managed MCP sessions closed")
        self._mcp_servers.clear()

    def _is_auth_forbidden(self, exc: Exception) -> bool:
        if isinstance(exc, InvalidStatus):
            response = getattr(exc, "response", None)
            if response is not None and getattr(response, "status_code", None) == 403:
                return True
        return "HTTP 403" in str(exc)

    async def _recover_token_after_403(self) -> bool:
        """
        Recover auth after 403 by trying OAuth refresh first, then manual token prompt.

        This keeps long-running sessions alive without forcing browser login each time.
        """
        if self._refresh_jwt is not None:
            try:
                refreshed = await asyncio.to_thread(self._refresh_jwt)
            except Exception as exc:
                logger.warning("oauth refresh failed after 403: %s", exc)
                refreshed = None
            if refreshed:
                token, subject = refreshed
                self.config.jwt_token = token
                os.environ["AGENT_JWT"] = token
                if subject:
                    self.config.subject = subject
                    os.environ["SUBJECT"] = subject
                return True
        if self._prompt_for_token is None:
            return False
        token = self._prompt_for_token().strip()
        if not token:
            return False
        self.config.jwt_token = token
        os.environ["AGENT_JWT"] = token
        updates = {"jwt_token": token}
        if self._derive_subject is not None:
            subject = self._derive_subject(token).strip()
            if subject:
                self.config.subject = subject
                os.environ["SUBJECT"] = subject
                updates["subject"] = subject
        if self._persist_updates is not None:
            self._persist_updates(updates)
        return True

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
        started = asyncio.get_running_loop().time()
        logger.debug("invoke received request_id=%s mcp_server=%s", request_id, mcp_server)
        try:
            result = await self._invoke_local_mcp_server(request_id, mcp_server, payload)
        except Exception as exc:
            logger.exception("invoke failed request_id=%s mcp_server=%s", request_id, mcp_server)
            result = self._error_result(payload, str(exc))
        elapsed = asyncio.get_running_loop().time() - started
        logger.debug("invoke finished request_id=%s mcp_server=%s elapsed=%.3fs", request_id, mcp_server, elapsed)
        await self._send_result(websocket, request_id, result)

    async def _send_result(self, websocket: Any, request_id: str, result: dict[str, Any]) -> None:
        async with self._send_lock:
            await websocket.send(json.dumps({"type": "result", "request_id": request_id, "result": result}))
        logger.debug("result sent request_id=%s", request_id)

    def _error_result(self, payload: Any, message: str) -> dict[str, Any]:
        request_id = payload.get("id") if isinstance(payload, dict) else None
        if request_id is None:
            return {"ok": False, "error": message}
        return {"jsonrpc": "2.0", "id": request_id, "error": {"code": -32000, "message": message}}

    async def _invoke_local_mcp_server(self, request_id: str, mcp_server: str, payload: dict[str, Any]) -> dict[str, Any]:
        managed = self._mcp_servers.get(mcp_server)
        if managed is not None:
            if isinstance(payload, dict):
                timeout_seconds = max(1.0, self.config.request_timeout_seconds - 1.0)
                try:
                    return await asyncio.wait_for(managed.handle_jsonrpc(payload), timeout=timeout_seconds)
                except TimeoutError:
                    logger.warning(
                        "managed_mcp_timeout request_id=%s mcp_server=%s timeout=%.1fs",
                        request_id,
                        mcp_server,
                        timeout_seconds,
                    )
                    return self._error_result(payload, f"Local MCP server '{mcp_server}' timed out after {timeout_seconds:.1f}s")
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

    async def _run_with_spinner(self, task_label: str, awaitable: Any, interval_seconds: float = 0.25) -> Any:
        if not sys.stdout.isatty():
            return await awaitable

        done = asyncio.Event()
        loop = asyncio.get_running_loop()
        start = loop.time()
        encoding = (getattr(sys.stdout, "encoding", None) or "").lower()
        if "utf" in encoding:
            frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
        else:
            frames = ["-", "\\", "|", "/"]

        async def _ticker() -> None:
            step = 0
            while not done.is_set():
                elapsed = loop.time() - start
                icon = frames[step % len(frames)]
                print(f"\r[mcp] {task_label} {icon} initializing {elapsed:.1f}s", end="", flush=True)
                step += 1
                try:
                    await asyncio.wait_for(done.wait(), timeout=interval_seconds)
                except TimeoutError:
                    continue

        ticker_task = asyncio.create_task(_ticker())
        try:
            return await awaitable
        finally:
            done.set()
            await ticker_task
            print("\r" + " " * 120 + "\r", end="", flush=True)
