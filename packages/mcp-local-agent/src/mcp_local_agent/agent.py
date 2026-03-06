from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
import signal
import sys
from contextlib import AsyncExitStack
from dataclasses import asdict, is_dataclass
from importlib.metadata import PackageNotFoundError, version as pkg_version
from typing import Any
from urllib.parse import urlparse

import httpx
import jwt
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed
from websockets.exceptions import InvalidStatus

from .config import AgentConfig, load_config, load_config_file, resolve_config_path, save_config_updates


def configure_logging() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s", force=True)


logger = logging.getLogger("mcp_local_agent")
DEFAULT_PROTOCOL_VERSION = os.getenv("MCP_PROTOCOL_VERSION", "2025-11-25")
APP_TITLE = "MCP ASSISTANT PROXY"


def _console(msg: str) -> None:
    print(msg, flush=True)


def _log(tag: str, message: str, *, color: str = "36", bold: bool = False) -> None:
    prefix = _style(f"[{tag}]", color=color, bold=bold)
    _console(f"{prefix} {message}")


def _agent_version() -> str:
    try:
        return pkg_version("mcpassistant-gateway")
    except PackageNotFoundError:
        return "dev"


def _supports_color() -> bool:
    if os.getenv("NO_COLOR"):
        return False
    if not sys.stdout.isatty():
        return False
    if os.name == "nt":
        # Windows Terminal, modern PowerShell, and VS Code terminals support ANSI.
        if os.getenv("WT_SESSION") or os.getenv("TERM_PROGRAM") or os.getenv("ANSICON") or os.getenv("ConEmuANSI") == "ON":
            return True
        return True
    term = os.getenv("TERM", "").lower()
    return term not in {"", "dumb"}


def _supports_unicode_output() -> bool:
    encoding = (getattr(sys.stdout, "encoding", None) or "").lower()
    if not encoding:
        return False
    return "utf" in encoding


def _style(text: str, *, color: str = "", bold: bool = False) -> str:
    if not _supports_color():
        return text
    codes: list[str] = []
    if bold:
        codes.append("1")
    if color:
        codes.append(color)
    if not codes:
        return text
    return f"\x1b[{';'.join(codes)}m{text}\x1b[0m"


def _gradient_style(text: str, start_rgb: tuple[int, int, int], end_rgb: tuple[int, int, int], *, bold: bool = False) -> str:
    if not _supports_color():
        return text
    chars = list(text)
    total = len([ch for ch in chars if ch != "\n"])
    if total <= 1:
        r, g, b = start_rgb
        prefix = f"\x1b[1;38;2;{r};{g};{b}m" if bold else f"\x1b[38;2;{r};{g};{b}m"
        return f"{prefix}{text}\x1b[0m"

    out: list[str] = []
    idx = 0
    for ch in chars:
        if ch == "\n":
            out.append(ch)
            continue
        t = idx / (total - 1)
        r = round(start_rgb[0] + (end_rgb[0] - start_rgb[0]) * t)
        g = round(start_rgb[1] + (end_rgb[1] - start_rgb[1]) * t)
        b = round(start_rgb[2] + (end_rgb[2] - start_rgb[2]) * t)
        if bold:
            out.append(f"\x1b[1;38;2;{r};{g};{b}m{ch}")
        else:
            out.append(f"\x1b[38;2;{r};{g};{b}m{ch}")
        idx += 1
    out.append("\x1b[0m")
    return "".join(out)


def _frame(lines: list[str]) -> str:
    width = max(len(line) for line in lines) if lines else 0
    border = "+" + "-" * (width + 2) + "+"
    body = [f"| {line.ljust(width)} |" for line in lines]
    return "\n".join([border, *body, border])


def _print_start_prompt() -> None:
    lines = [
        APP_TITLE,
        "Paste AGENT_JWT to continue startup",
    ]
    _console(_style(_frame(lines), color="33", bold=True))

def _print_runtime_header() -> None:
    version = _agent_version()
    title = [
        " __  __  ____ ____      _    ____ ____ ___ ____ _____ _    _   _ _____ ",
        "|  \\/  |/ ___|  _ \\    / \\  / ___/ ___|_ _/ ___|_   _/ \\  | \\ | |_   _|",
        "| |\\/| | |   | |_) |  / _ \\ \\___ \\___ \\| |\\___ \\ | |/ _ \\ |  \\| | | |  ",
        "| |  | | |___|  __/  / ___ \\ ___) |__) | | ___) || / ___ \\| |\\  | | |  ",
        "|_|  |_|\\____|_|    /_/   \\_\\____/____/___|____/ |_/_/   \\_\\_| \\_| |_|  ",
        f"                   {APP_TITLE}  v{version}",
    ]
    _console(_gradient_style("\n".join(title), (255, 64, 64), (255, 255, 255), bold=True))
    _console(_style("Tips:", color="35", bold=True))
    _console(_style("1. Keep AGENT_JWT valid for uninterrupted bridge sessions.", color="35"))
    _console(_style("2. Use Ctrl+C to stop gracefully.", color="35"))
    _console(_style("3. Check [mcp] and [bridge] phase logs for progress.\n", color="35"))


def _prompt_for_token() -> str:
    _print_start_prompt()
    _console(_style("No AGENT_JWT found in environment or config.", color="33", bold=True))
    while True:
        token = input("Paste AGENT_JWT token: ").strip()
        if token:
            return token
        _console(_style("Token is required to start the bridge agent.", color="31", bold=True))


def _prompt_text(label: str, default: str | None = None) -> str:
    suffix = f" [{default}]" if default else ""
    while True:
        value = input(f"{label}{suffix}: ").strip()
        if value:
            return value
        if default:
            return default
        _console(_style(f"{label} is required.", color="31", bold=True))


async def _run_with_spinner(task_label: str, awaitable: Any, interval_seconds: float = 0.12) -> Any:
    if not sys.stdout.isatty():
        return await awaitable

    done = asyncio.Event()
    loop = asyncio.get_running_loop()
    start = loop.time()
    frames = (
        ["\u280b", "\u2819", "\u2839", "\u2838", "\u283c", "\u2834", "\u2826", "\u2827", "\u2807", "\u280f"]
        if _supports_unicode_output()
        else ["-", "\\", "|", "/"]
    )
    async def _ticker() -> None:
        step = 0
        while not done.is_set():
            elapsed = loop.time() - start
            icon = frames[step % len(frames)]
            if _supports_color():
                icon = _style(icon, color="36", bold=True)
            message = f"\r{task_label} {icon} initializing {elapsed:.1f}s"
            print(message, end="", flush=True)
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
        # Clear spinner line before next normal log line.
        print("\r" + " " * 120 + "\r", end="", flush=True)


def _token_from_sources() -> str:
    env_token = os.getenv("AGENT_JWT", "").strip()
    if env_token:
        return env_token
    cfg = load_config_file()
    return str(cfg.get("jwt_token") or cfg.get("agent_jwt") or "").strip()


def _persist_updates(updates: dict[str, str]) -> None:
    path = save_config_updates(updates)
    _console(_style(f"Saved startup settings to {path}", color="36"))


def _print_config_tip(config: AgentConfig) -> None:
    cfg_path = resolve_config_path()
    server_count = len(config.mcp_servers or {})
    _log("tip", f"config: {cfg_path}", color="36")
    _log("tip", f"edit mcpServers in config.json to add MCP servers (current: {server_count})", color="36")


def _derive_agent_id_from_token(token: str) -> str:
    try:
        claims = jwt.decode(token, options={"verify_signature": False, "verify_exp": False})
        sub = str(claims.get("sub", "")).strip()
        if sub:
            return sub
    except Exception:
        pass
    # Fallback to existing config derivation rules
    try:
        from .config import _derive_agent_id as _cfg_derive_agent_id  # type: ignore
        return _cfg_derive_agent_id(token, {})
    except Exception:
        return ""


def _load_config_with_prompt() -> AgentConfig:
    while True:
        try:
            return load_config()
        except RuntimeError as exc:
            message = str(exc)
            updates: dict[str, str] = {}

            token = _token_from_sources()
            if "AGENT_JWT is not a valid JWT format" in message:
                _console(_style("Current AGENT_JWT is invalid.", color="31", bold=True))
                token = _prompt_for_token()
                updates["jwt_token"] = token
                os.environ["AGENT_JWT"] = token
                new_agent_id = _derive_agent_id_from_token(token)
                if new_agent_id:
                    updates["agent_id"] = new_agent_id
                    os.environ["AGENT_ID"] = new_agent_id
            elif "Missing AGENT_JWT" in message:
                token = _prompt_for_token()
                updates["jwt_token"] = token
                os.environ["AGENT_JWT"] = token
                new_agent_id = _derive_agent_id_from_token(token)
                if new_agent_id:
                    updates["agent_id"] = new_agent_id
                    os.environ["AGENT_ID"] = new_agent_id

            if "Missing REMOTE_WEBSOCKET_URL/REMOTE_SERVER_BASE_URL" in message:
                base_url = _prompt_text("Enter remote server base URL", "http://127.0.0.1:8000")
                updates["remote_server_base_url"] = base_url
                os.environ["REMOTE_SERVER_BASE_URL"] = base_url

            if updates:
                _persist_updates(updates)
                continue

            raise


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
        self._send_lock = asyncio.Lock()
        self._inflight_tasks: set[asyncio.Task[None]] = set()

    async def run(self) -> None:
        await self._start_mcp_servers_if_configured()
        _log("bridge", f"starting: websocket={self.config.websocket_url} agent_id={self.config.agent_id}", color="32", bold=True)
        backoff = self.config.reconnect_initial_delay_seconds
        attempt = 0

        try:
            while not self._stop_event.is_set():
                attempt += 1
                try:
                    _log("bridge", f"connecting websocket (attempt {attempt})", color="32")
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
                    _log("bridge", f"reconnecting in {backoff:.1f}s due to error: {exc}", color="33", bold=True)
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
            register_msg = {"type": "register", "agent_id": self.config.agent_id, "capabilities": announced_servers}
            await websocket.send(json.dumps(register_msg))
            _log("bridge", f"connected and registered mcp_servers={','.join(announced_servers)}", color="32", bold=True)

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
            _log("mcp", "no mcpServers configured", color="33")
            return

        if os.getenv("START_MCP_SERVERS", "true").strip().lower() in {"0", "false", "no", "off"}:
            _log("mcp", "START_MCP_SERVERS=false; skipping mcpServers startup", color="33")
            return

        total = len(servers)
        _log("mcp", f"initializing {total} MCP server session(s)", color="35", bold=True)
        for index, (name, cfg) in enumerate(servers.items(), start=1):
            if not isinstance(cfg, dict):
                _log("mcp", f"[{index}/{total}] skipping '{name}' (invalid config object)", color="33")
                continue
            managed = ManagedMCPServer(name, cfg)
            try:
                start_at = asyncio.get_running_loop().time()
                _log("mcp", f"[{index}/{total}] starting '{name}' ...", color="35")
                await _run_with_spinner(f"[mcp] [{index}/{total}] '{name}'", managed.start())
                self._mcp_servers[name] = managed
                elapsed = asyncio.get_running_loop().time() - start_at
                _log("mcp", f"[{index}/{total}] ready '{name}' via stdio MCP client ({elapsed:.1f}s)", color="32")
            except Exception as exc:
                _log("mcp", f"[{index}/{total}] failed '{name}': {exc}", color="31", bold=True)

    async def _stop_mcp_servers(self) -> None:
        for name, managed in list(self._mcp_servers.items()):
            try:
                await managed.close()
            except Exception as exc:
                logger.warning("error while closing MCP server '%s': %s", name, exc)
        if self._mcp_servers:
            _log("mcp", "all managed MCP sessions closed", color="35")
        self._mcp_servers.clear()

    def _is_auth_forbidden(self, exc: Exception) -> bool:
        if isinstance(exc, InvalidStatus):
            response = getattr(exc, "response", None)
            if response is not None and getattr(response, "status_code", None) == 403:
                return True
        return "HTTP 403" in str(exc)

    async def _recover_token_after_403(self) -> bool:
        _console(_style("[bridge] authorization failed (HTTP 403).", color="31", bold=True))
        if not sys.stdin.isatty():
            _console(_style("[bridge] non-interactive terminal; cannot prompt for token.", color="33", bold=True))
            return False

        token = _prompt_for_token()
        self.config.jwt_token = token
        os.environ["AGENT_JWT"] = token
        new_agent_id = _derive_agent_id_from_token(token)
        updates = {"jwt_token": token}
        if new_agent_id:
            self.config.agent_id = new_agent_id
            os.environ["AGENT_ID"] = new_agent_id
            updates["agent_id"] = new_agent_id
        _persist_updates(updates)
        _console(_style("[bridge] token updated. retrying now.", color="32", bold=True))
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
        logger.info("invoke received request_id=%s mcp_server=%s", request_id, mcp_server)

        try:
            result = await self._invoke_local_mcp_server(request_id, mcp_server, payload)
        except Exception as exc:
            logger.exception("invoke failed request_id=%s mcp_server=%s", request_id, mcp_server)
            result = self._error_result(payload, str(exc))

        elapsed = asyncio.get_running_loop().time() - started
        logger.info("invoke finished request_id=%s mcp_server=%s elapsed=%.3fs", request_id, mcp_server, elapsed)
        await self._send_result(websocket, request_id, result)

    async def _send_result(self, websocket: Any, request_id: str, result: dict[str, Any]) -> None:
        async with self._send_lock:
            await websocket.send(json.dumps({"type": "result", "request_id": request_id, "result": result}))
        logger.info("result sent request_id=%s", request_id)

    def _error_result(self, payload: Any, message: str) -> dict[str, Any]:
        request_id = payload.get("id") if isinstance(payload, dict) else None
        if request_id is None:
            return {"ok": False, "error": message}
        return {
            "jsonrpc": "2.0",
            "id": request_id,
            "error": {"code": -32000, "message": message},
        }

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


async def _main() -> None:
    configure_logging()
    _print_runtime_header()
    config = _load_config_with_prompt()
    _print_config_tip(config)
    _console(_style(_frame([f"Agent: {config.agent_id}", f"WebSocket: {config.websocket_url}"]), color="32", bold=True))
    _log("boot", f"loaded config: agent_id={config.agent_id} websocket={config.websocket_url}", color="36")
    _log("boot", f"mcpServers keys: {list((config.mcp_servers or {}).keys())}", color="36")
    try:
        claims = jwt.decode(config.jwt_token, options={"verify_signature": False, "verify_exp": False})
        _log("boot", "jwt summary: sub=%s role=%s mcp_servers=%s" % (claims.get("sub", ""), claims.get("role", ""), len(claims.get("capabilities", []) or [])), color="36")
    except Exception:
        _log("boot", "unable to parse AGENT_JWT claims", color="33")

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
    _log("boot", "shutdown requested. closing bridge...", color="33", bold=True)
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









