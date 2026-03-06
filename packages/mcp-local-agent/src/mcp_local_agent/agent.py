from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import queue
import shlex
import shutil
import signal
import socket
import sys
import time
import webbrowser
from collections import deque
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Event, Lock, Thread
from contextlib import AsyncExitStack, redirect_stderr, redirect_stdout
from dataclasses import asdict, is_dataclass
from importlib.metadata import PackageNotFoundError, version as pkg_version
from io import StringIO
from typing import Any
from urllib.parse import parse_qs, urlparse

try:
    import msvcrt
except ImportError:  # pragma: no cover - non-Windows platforms
    msvcrt = None  # type: ignore[assignment]

try:
    from prompt_toolkit import PromptSession
    from prompt_toolkit.formatted_text import FormattedText
    from prompt_toolkit.patch_stdout import patch_stdout as PTPatchStdout
    from prompt_toolkit.styles import Style as PTStyle
except Exception:  # pragma: no cover - prompt_toolkit optional
    PromptSession = None  # type: ignore[assignment]
    FormattedText = None  # type: ignore[assignment]
    PTPatchStdout = None  # type: ignore[assignment]
    PTStyle = None  # type: ignore[assignment]

import httpx
import jwt
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed
from websockets.exceptions import InvalidStatus

from .config import AgentConfig, ensure_default_config, load_config, load_config_file, resolve_config_path, save_config_updates


def configure_logging() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s", force=True)
    root = logging.getLogger()
    exists = any(getattr(handler, "name", "") == "mcp_menu_buffer" for handler in root.handlers)
    if not exists:
        buffer_handler = _MenuLogBufferHandler(level=logging.DEBUG)
        buffer_handler.set_name("mcp_menu_buffer")
        buffer_handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s %(message)s"))
        root.addHandler(buffer_handler)


logger = logging.getLogger("mcp_local_agent")
DEFAULT_PROTOCOL_VERSION = os.getenv("MCP_PROTOCOL_VERSION", "2025-11-25")
APP_TITLE = "MCP ASSISTANT PROXY"
_MENU_PROMPT_SESSION: Any | None = None
_MENU_PROMPT_STYLE: Any | None = None
_MENU_LOG_BUFFER: deque[str] = deque(maxlen=1000)
_MENU_LOG_LOCK = Lock()
_MENU_ACTIVE = False


class _MenuLogBufferHandler(logging.Handler):
    def emit(self, record: logging.LogRecord) -> None:
        try:
            line = self.format(record)
        except Exception:
            line = record.getMessage()
        with _MENU_LOG_LOCK:
            _MENU_LOG_BUFFER.append(line)


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


def _menu_input_box() -> str:
    width = 72
    if _supports_unicode_output():
        top = "┌" + "─" * width + "┐"
        bottom = "└" + "─" * width + "┘"
        _console(_style(top, color="36", bold=True))
        raw = input(_style("│ ", color="36", bold=True) + _style("❯ ", color="35", bold=True)).strip()
        _console(_style(bottom, color="36", bold=True))
        _console(_style(datetime.now().strftime("%Y-%m-%d %H:%M:%S"), color="90"))
        return raw
    top = "+" + "-" * width + "+"
    bottom = "+" + "-" * width + "+"
    _console(_style(top, color="36", bold=True))
    raw = input(_style("| ", color="36", bold=True) + _style("> ", color="35", bold=True)).strip()
    _console(_style(bottom, color="36", bold=True))
    _console(_style(datetime.now().strftime("%Y-%m-%d %H:%M:%S"), color="90"))
    return raw


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
    if _MENU_ACTIVE:
        return await awaitable
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


def _derive_subject_from_token(token: str) -> str:
    try:
        claims = jwt.decode(token, options={"verify_signature": False, "verify_exp": False})
        sub = str(claims.get("sub", "")).strip()
        if sub:
            return sub
    except Exception:
        pass
    # Fallback to existing config derivation rules
    try:
        from .config import _derive_subject as _cfg_derive_subject  # type: ignore
        return _cfg_derive_subject(token, {})
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
                new_subject = _derive_subject_from_token(token)
                if new_subject:
                    updates["subject"] = new_subject
                    os.environ["SUBJECT"] = new_subject
            elif "Missing AGENT_JWT" in message:
                token = _prompt_for_token()
                updates["jwt_token"] = token
                os.environ["AGENT_JWT"] = token
                new_subject = _derive_subject_from_token(token)
                if new_subject:
                    updates["subject"] = new_subject
                    os.environ["SUBJECT"] = new_subject

            if "Missing REMOTE_WEBSOCKET_URL/REMOTE_SERVER_BASE_URL" in message:
                base_url = _prompt_text("Enter remote server base URL", "http://127.0.0.1:8000")
                updates["remote_server_base_url"] = base_url
                os.environ["REMOTE_SERVER_BASE_URL"] = base_url

            if updates:
                _persist_updates(updates)
                continue

            raise


def _parse_cli_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="mcpassistant-gateway", description="Run and manage the local MCP bridge agent")
    subparsers = parser.add_subparsers(dest="command")

    run_parser = subparsers.add_parser("run", help="Run the local MCP bridge agent")
    run_parser.set_defaults(command="run")
    run_parser.add_argument("--config", default="", help="Path to config.json")
    run_parser.add_argument("--subject", default="", help="Override subject for this run")
    run_parser.add_argument("--jwt-token", default="", help="Override AGENT_JWT for this run")
    run_parser.add_argument("--remote-server-base-url", default="", help="Override remote server base URL")
    run_parser.add_argument("--websocket-url", default="", help="Override remote websocket URL")
    run_parser.add_argument("--request-timeout-seconds", type=float, default=None, help="Override local request timeout")

    config_parser = subparsers.add_parser("config", help="Inspect or update config.json")
    config_subparsers = config_parser.add_subparsers(dest="config_command", required=True)

    config_path_parser = config_subparsers.add_parser("path", help="Print the resolved config path")
    config_path_parser.add_argument("--config", default="", help="Path to config.json")

    config_show_parser = config_subparsers.add_parser("show", help="Print the current config.json")
    config_show_parser.add_argument("--config", default="", help="Path to config.json")

    config_init_parser = config_subparsers.add_parser("init", help="Create config.json if it does not exist")
    config_init_parser.add_argument("--config", default="", help="Path to config.json")

    config_set_parser = config_subparsers.add_parser("set", help="Update config.json settings")
    config_set_parser.add_argument("--config", default="", help="Path to config.json")
    config_set_parser.add_argument("--subject", default="", help="Persist subject")
    config_set_parser.add_argument("--jwt-token", default="", help="Persist JWT token")
    config_set_parser.add_argument("--remote-server-base-url", default="", help="Persist remote server base URL")
    config_set_parser.add_argument("--websocket-url", default="", help="Persist websocket URL")
    config_set_parser.add_argument("--request-timeout-seconds", type=float, default=None, help="Persist local request timeout")

    settings_parser = subparsers.add_parser("settings", help="Interactive settings editor")
    settings_parser.add_argument("--config", default="", help="Path to config.json")

    menu_parser = subparsers.add_parser("menu", help="Open an interactive CLI menu")
    menu_parser.add_argument("--config", default="", help="Path to config.json")

    args = parser.parse_args()
    if args.command is None:
        # Default to interactive menu for a single-entry CLI UX.
        # Preserve legacy behavior for flag-only invocation.
        if len(sys.argv) > 1 and sys.argv[1].startswith("-"):
            args = parser.parse_args(["run", *sys.argv[1:]])
        else:
            args = parser.parse_args(["menu", *sys.argv[1:]])
    return args


def _apply_cli_overrides(args: argparse.Namespace) -> None:
    if getattr(args, "config", ""):
        os.environ["AGENT_CONFIG_PATH"] = args.config
    if getattr(args, "subject", ""):
        os.environ["SUBJECT"] = args.subject
    if getattr(args, "jwt_token", ""):
        os.environ["AGENT_JWT"] = args.jwt_token
    if getattr(args, "remote_server_base_url", ""):
        os.environ["REMOTE_SERVER_BASE_URL"] = args.remote_server_base_url
    if getattr(args, "websocket_url", ""):
        os.environ["REMOTE_WEBSOCKET_URL"] = args.websocket_url
    if getattr(args, "request_timeout_seconds", None) is not None:
        os.environ["REQUEST_TIMEOUT_SECONDS"] = str(args.request_timeout_seconds)


def _config_updates_from_args(args: argparse.Namespace) -> dict[str, Any]:
    updates: dict[str, Any] = {}
    if getattr(args, "subject", ""):
        updates["subject"] = args.subject
    if getattr(args, "jwt_token", ""):
        updates["jwt_token"] = args.jwt_token
    if getattr(args, "remote_server_base_url", ""):
        updates["remote_server_base_url"] = args.remote_server_base_url
    if getattr(args, "websocket_url", ""):
        updates["websocket_url"] = args.websocket_url
    if getattr(args, "request_timeout_seconds", None) is not None:
        updates["request_timeout_seconds"] = max(1.0, float(args.request_timeout_seconds))
    return updates


def _print_config_json() -> None:
    cfg_path = resolve_config_path()
    cfg = load_config_file(cfg_path)
    _console(json.dumps(cfg, indent=2))


def _prompt_setting(current: dict[str, Any], key: str, label: str, secret: bool = False) -> str:
    default = str(current.get(key, "")).strip()
    suffix = " [hidden]" if secret and default else (f" [{default}]" if default else "")
    value = input(f"{label}{suffix}: ").strip()
    if value:
        return value
    return default


def _interactive_settings_editor() -> None:
    cfg_path = resolve_config_path()
    ensure_default_config(cfg_path)
    current = load_config_file(cfg_path)
    updates: dict[str, Any] = {}

    _console(_style(f"Editing settings in {cfg_path}", color="36", bold=True))
    updates["subject"] = _prompt_setting(current, "subject", "Subject")
    updates["jwt_token"] = _prompt_setting(current, "jwt_token", "JWT token", secret=True)
    updates["remote_server_base_url"] = _prompt_setting(current, "remote_server_base_url", "Remote server base URL")

    current_timeout = current.get("request_timeout_seconds", 20)
    timeout_raw = input(f"Request timeout seconds [{current_timeout}]: ").strip()
    if timeout_raw:
        updates["request_timeout_seconds"] = max(1.0, float(timeout_raw))
    elif current_timeout:
        updates["request_timeout_seconds"] = current_timeout

    save_config_updates(updates, cfg_path)
    _console(_style(f"Saved settings to {cfg_path}", color="32", bold=True))


def _menu_manage_base_url(current: dict[str, Any]) -> str:
    base = str(current.get("remote_server_base_url", "")).strip()
    if base:
        return base.rstrip("/")
    ws = str(current.get("websocket_url", "")).strip()
    if ws.startswith("wss://"):
        return "https://" + ws.removeprefix("wss://").removesuffix("/connect")
    if ws.startswith("ws://"):
        return "http://" + ws.removeprefix("ws://").removesuffix("/connect")
    return ""


def _http_base_from_websocket_url(websocket_url: str) -> str:
    ws = websocket_url.strip()
    if ws.startswith("wss://"):
        return "https://" + ws.removeprefix("wss://").removesuffix("/connect")
    if ws.startswith("ws://"):
        return "http://" + ws.removeprefix("ws://").removesuffix("/connect")
    return ws.removesuffix("/connect")


def _menu_capabilities(current: dict[str, Any]) -> list[str]:
    configured = current.get("capabilities")
    if isinstance(configured, list) and configured:
        return [str(item) for item in configured if str(item).strip()]
    servers = current.get("mcpServers")
    if isinstance(servers, dict) and servers:
        return [str(name) for name in servers.keys()]
    return ["*"]


def _menu_prompt_expiry(expiry_minutes: int | None = None) -> int | None:
    default_expiry = expiry_minutes if expiry_minutes is not None else 1440
    expiry_raw = input(f"Expiry minutes [{default_expiry}]: ").strip()
    try:
        expiry = int(expiry_raw) if expiry_raw else int(default_expiry)
    except ValueError:
        _console(_style("Expiry minutes must be an integer.", color="31", bold=True))
        return None
    return max(1, expiry)


def _select_login_mode_interactive() -> str:
    options: list[tuple[str, str]] = [
        ("oauth", "OAuth (Google via Supabase)"),
        ("jwt", "JWT fallback (manual subject token issue)"),
        ("back", "Back"),
    ]
    if msvcrt is not None and sys.stdin.isatty() and sys.stdout.isatty():
        selected = 0
        rendered_lines = 0
        while True:
            if rendered_lines > 0:
                if _supports_color():
                    # Move cursor up and clear previously rendered selector block.
                    print(f"\x1b[{rendered_lines}F", end="")
                    for _ in range(rendered_lines):
                        print("\x1b[2K", end="")
                        print("\x1b[1E", end="")
                    print(f"\x1b[{rendered_lines}F", end="")
                else:
                    _console("")
            _console(_style("Select login mode (Up/Down/PageUp/PageDown + Enter, Esc to go back):", color="36", bold=True))
            for idx, (_, label) in enumerate(options):
                prefix = "> " if idx == selected else "  "
                color = "36" if idx == selected else "37"
                _console(_style(f"{prefix}{label}", color=color, bold=(idx == selected)))
            rendered_lines = 1 + len(options)
            key = msvcrt.getwch()
            if key in {"\r", "\n"}:
                return options[selected][0]
            if key == "\x1b":
                return "back"
            if key in {"\x00", "\xe0"}:
                ext = msvcrt.getwch()
                if ext in {"H", "I"}:  # Up / PageUp
                    selected = (selected - 1) % len(options)
                elif ext in {"P", "Q"}:  # Down / PageDown
                    selected = (selected + 1) % len(options)
            continue

    _console(_style("Login mode:", color="36", bold=True))
    _console(_style("1. OAuth (Google via Supabase)", color="37"))
    _console(_style("2. JWT fallback (manual subject token issue)", color="37"))
    _console(_style("3. Back", color="37"))
    while True:
        raw = input("Choose [1/2/3]: ").strip()
        if raw in {"1", "oauth", "OAuth", "OAUTH"}:
            return "oauth"
        if raw in {"2", "jwt", "JWT"}:
            return "jwt"
        if raw in {"3", "back", "Back", "BACK"}:
            return "back"
        _console(_style("Please enter 1, 2, or 3.", color="31", bold=True))


def _menu_login_legacy(base: str, subject: str, expiry: int, caps: list[str], cfg_path: Any) -> None:
    endpoint = f"{base}/manage/jwt/issue"
    try:
        response = httpx.post(
            endpoint,
            json={"subject": subject, "expiry_minutes": expiry, "capabilities": caps},
            timeout=20.0,
        )
        response.raise_for_status()
        payload = response.json()
    except Exception as exc:
        _console(_style(f"/login failed: {exc}", color="31", bold=True))
        return

    token = str(payload.get("token", "")).strip() if isinstance(payload, dict) else ""
    if not token:
        _console(_style("/login failed: token missing in response.", color="31", bold=True))
        return

    save_config_updates(
        {
            "subject": subject,
            "jwt_token": token,
            "auth_profile": {"mode": "jwt", "subject": subject},
        },
        cfg_path,
    )
    _console(_style("Login successful (legacy JWT issue).", color="32", bold=True))


def _find_local_callback_port() -> int | None:
    port = 43110
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind(("127.0.0.1", port))
        except OSError:
            return None
    return port


def _start_local_oauth_callback_server(port: int) -> tuple[ThreadingHTTPServer, queue.Queue[dict[str, str]], Thread]:
    result_queue: queue.Queue[dict[str, str]] = queue.Queue(maxsize=1)

    class CallbackHandler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802
            parsed = urlparse(self.path)
            if parsed.path not in {"/callback", "/callback/"}:
                if parsed.path == "/favicon.ico":
                    self.send_response(204)
                    self.end_headers()
                    return
                self.send_response(404)
                self.end_headers()
                return
            query = parse_qs(parsed.query)
            payload = {
                "code": (query.get("code") or [""])[0],
                "session_id": (query.get("session_id") or [""])[0],
                "error": (query.get("error") or [""])[0],
                "error_description": (query.get("error_description") or [""])[0],
            }
            try:
                result_queue.put_nowait(payload)
            except queue.Full:
                pass

            body = """<!doctype html>
<html lang='en'>
  <head>
    <meta charset='utf-8' />
    <meta name='viewport' content='width=device-width, initial-scale=1' />
    <title>MCP Assistant Login Complete</title>
    <style>
      * { box-sizing: border-box; }
      html, body {
        width: 100%;
        height: 100%;
        margin: 0;
      }
      body {
        display: flex;
        align-items: center;
        justify-content: center;
        background: #ffffff;
        color: #111111;
        font-family: Segoe UI, Arial, sans-serif;
        text-align: center;
      }
      main {
        padding: 14px;
      }
      .logo {
        width: 56px;
        height: auto;
        margin: 0 auto 10px;
        display: block;
      }
      h2 {
        margin: 0 0 6px;
        font-size: 1.35rem;
        font-weight: 600;
      }
      p {
        margin: 0;
        color: #111111;
        font-size: 0.98rem;
      }
    </style>
  </head>
  <body>
    <main>
      <img class='logo' src='https://mcp-assistant.in/logo.svg' alt='MCP Assistant' />
      <h2>Login complete</h2>
      <p>You can return to the terminal now.</p>
    </main>
    <script>
      setTimeout(() => {
        try { window.close(); } catch (e) {}
      }, 1200);
    </script>
  </body>
</html>"""
            encoded = body.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)

        def log_message(self, format: str, *args: Any) -> None:  # noqa: A003
            return

    server = ThreadingHTTPServer(("127.0.0.1", port), CallbackHandler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, result_queue, thread


def _menu_login_oauth(base: str, subject: str, expiry: int, caps: list[str], cfg_path: Any) -> bool:
    callback_port = _find_local_callback_port()
    if callback_port is None:
        _console(_style("/login failed: no free localhost callback port found.", color="31", bold=True))
        return True
    callback_url = f"http://127.0.0.1:{callback_port}/callback"
    callback_server, callback_queue, callback_thread = _start_local_oauth_callback_server(callback_port)

    start_endpoint = f"{base}/manage/oauth/start"
    try:
        start_resp = httpx.post(
            start_endpoint,
            json={
                "subject": subject,
                "expiry_minutes": expiry,
                "capabilities": caps,
                "redirect_uri": callback_url,
            },
            timeout=20.0,
        )
    except Exception as exc:
        callback_server.shutdown()
        callback_server.server_close()
        callback_thread.join(timeout=2.0)
        _console(_style(f"/login failed: cannot reach OAuth start endpoint: {exc}", color="31", bold=True))
        return False

    if start_resp.status_code in {404, 405, 503}:
        callback_server.shutdown()
        callback_server.server_close()
        callback_thread.join(timeout=2.0)
        return False
    try:
        start_resp.raise_for_status()
        body = start_resp.json()
    except Exception as exc:
        callback_server.shutdown()
        callback_server.server_close()
        callback_thread.join(timeout=2.0)
        _console(_style(f"/login failed: OAuth start error: {exc}", color="31", bold=True))
        return True

    session_id = str(body.get("session_id", "")).strip() if isinstance(body, dict) else ""
    auth_url = str(body.get("auth_url", "")).strip() if isinstance(body, dict) else ""
    if not session_id or not auth_url:
        callback_server.shutdown()
        callback_server.server_close()
        callback_thread.join(timeout=2.0)
        _console(_style("/login failed: OAuth start response missing session_id/auth_url.", color="31", bold=True))
        return True

    _console(_style("Opening browser for Supabase login (localhost callback)...", color="36", bold=True))
    opened = False
    try:
        opened = bool(webbrowser.open(auth_url, new=2))
    except Exception:
        opened = False
    if not opened:
        _console(_style("Open this URL manually:", color="33", bold=True))
        _console(auth_url)
    _console(_style(f"Waiting for callback on {callback_url} ...", color="35"))

    callback: dict[str, str] | None = None
    deadline = time.time() + 300
    while time.time() < deadline:
        try:
            callback = callback_queue.get(timeout=1.0)
            break
        except queue.Empty:
            continue

    callback_server.shutdown()
    callback_server.server_close()
    callback_thread.join(timeout=2.0)

    if callback is None:
        _console(_style("/login timed out waiting for browser callback.", color="31", bold=True))
        return True

    error = callback.get("error", "").strip()
    if error:
        description = callback.get("error_description", "").strip()
        reason = description or error
        _console(_style(f"/login failed: {reason}", color="31", bold=True))
        return True

    code = callback.get("code", "").strip()
    callback_session_id = callback.get("session_id", "").strip()
    if not code:
        _console(_style("/login failed: callback missing code.", color="31", bold=True))
        return True
    if callback_session_id and callback_session_id != session_id:
        _console(_style("/login failed: callback session mismatch.", color="31", bold=True))
        return True

    complete_endpoint = f"{base}/manage/oauth/complete"
    try:
        complete_resp = httpx.post(
            complete_endpoint,
            json={"session_id": session_id, "code": code},
            timeout=20.0,
        )
        complete_resp.raise_for_status()
        complete_body = complete_resp.json()
    except Exception as exc:
        _console(_style(f"/login failed: OAuth completion failed: {exc}", color="31", bold=True))
        return True

    token = str(complete_body.get("token", "")).strip() if isinstance(complete_body, dict) else ""
    oauth_subject = str(complete_body.get("subject", "")).strip() if isinstance(complete_body, dict) else ""
    if not token:
        _console(_style("/login failed: missing token in OAuth completion.", color="31", bold=True))
        return True
    save_config_updates(
        {
            "subject": oauth_subject or subject,
            "jwt_token": token,
            "auth_profile": {
                "mode": "oauth",
                "subject": oauth_subject or subject,
                "email": str(complete_body.get("email", "")).strip() if isinstance(complete_body, dict) else "",
            },
        },
        cfg_path,
    )
    _console(_style("Login successful (OAuth localhost callback). JWT saved to config.", color="32", bold=True))
    return True


def _menu_login(cfg_path: Any, mode: str = "oauth", expiry_minutes: int | None = None) -> None:
    current = load_config_file(cfg_path)
    base = _menu_manage_base_url(current)
    if not base:
        _console(_style("remote_server_base_url is required for /login.", color="31", bold=True))
        return
    existing_token = str(current.get("jwt_token", "")).strip()
    if existing_token:
        _console(_style("Already logged in. Run /logout before /login again.", color="33", bold=True))
        return

    expiry = _menu_prompt_expiry(expiry_minutes)
    if expiry is None:
        return
    subject = str(current.get("subject", "")).strip()
    if not subject:
        token = str(current.get("jwt_token") or current.get("agent_jwt") or "").strip()
        if token:
            subject = _derive_subject_from_token(token)

    caps = _menu_capabilities(current)
    if mode == "oauth":
        oauth_handled = _menu_login_oauth(base=base, subject=subject, expiry=expiry, caps=caps, cfg_path=cfg_path)
        if oauth_handled:
            return
        _console(_style("OAuth endpoint unavailable. Falling back to legacy token issue.", color="33", bold=True))
    else:
        _console(_style("Using JWT fallback login mode.", color="33", bold=True))
    if not subject:
        subject = input("Subject: ").strip()
    if not subject:
        _console(_style("Subject is required for legacy token issue.", color="31", bold=True))
        return
    _menu_login_legacy(base=base, subject=subject, expiry=expiry, caps=caps, cfg_path=cfg_path)


def _menu_logout(cfg_path: Any) -> None:
    current = load_config_file(cfg_path)
    token = str(current.get("jwt_token", "")).strip()
    if not token:
        _console(_style("No jwt_token found in config.", color="33", bold=True))
        return

    base = _menu_manage_base_url(current)
    if base:
        endpoint = f"{base}/manage/jwt/revoke"
        try:
            response = httpx.post(endpoint, json={"token": token}, timeout=20.0)
            if response.status_code >= 400:
                _console(_style(f"/logout warning: revoke returned HTTP {response.status_code}", color="33", bold=True))
        except Exception as exc:
            _console(_style(f"/logout warning: revoke failed: {exc}", color="33", bold=True))

    save_config_updates({"jwt_token": "", "auth_profile": {}}, cfg_path)
    _console(_style("Logout successful. jwt_token cleared from config.", color="32", bold=True))


def _menu_input_box_fixed() -> str:
    global _MENU_PROMPT_SESSION, _MENU_PROMPT_STYLE
    if PromptSession is not None and PTStyle is not None and FormattedText is not None and sys.stdin.isatty() and sys.stdout.isatty():
        if _MENU_PROMPT_SESSION is None:
            _MENU_PROMPT_SESSION = PromptSession()
            _MENU_PROMPT_STYLE = PTStyle.from_dict(
                {
                    "prompt": "ansired bold",
                    "toolbar": "#8b949e",
                }
            )

        def _toolbar() -> FormattedText:
            ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            return FormattedText([("class:toolbar", ts)])

        if PTPatchStdout is not None:
            with PTPatchStdout(raw=True):
                raw = _MENU_PROMPT_SESSION.prompt(
                    [("class:prompt", "> ")],
                    style=_MENU_PROMPT_STYLE,
                    bottom_toolbar=_toolbar,
                    refresh_interval=1.0,
                )
        else:
            raw = _MENU_PROMPT_SESSION.prompt(
                [("class:prompt", "> ")],
                style=_MENU_PROMPT_STYLE,
                bottom_toolbar=_toolbar,
                refresh_interval=1.0,
            )
        return raw.strip()

    raw = input(_style("> ", color="31", bold=True)).strip()
    _console(_style(datetime.now().strftime("%Y-%m-%d %H:%M:%S"), color="90"))
    return raw


async def _run_menu_bridge_until_stopped(stop_event: Event) -> None:
    config = load_config()
    _print_config_tip(config)
    _console(_style(_frame([f"Subject: {config.subject}", f"WebSocket: {config.websocket_url}"]), color="32", bold=True))
    _log("boot", f"loaded config: subject={config.subject} websocket={config.websocket_url}", color="36")
    _log("boot", f"mcpServers keys: {list((config.mcp_servers or {}).keys())}", color="36")
    try:
        claims = jwt.decode(config.jwt_token, options={"verify_signature": False, "verify_exp": False})
        _log(
            "boot",
            "jwt summary: sub=%s role=%s mcp_servers=%s"
            % (claims.get("sub", ""), claims.get("role", ""), len(claims.get("capabilities", []) or [])),
            color="36",
        )
    except Exception:
        _log("boot", "unable to parse AGENT_JWT claims", color="33")

    agent = LocalBridgeAgent(config)
    runner = asyncio.create_task(agent.run())
    await asyncio.to_thread(stop_event.wait)
    _log("boot", "stop requested from menu. closing bridge...", color="33", bold=True)
    await agent.stop()
    runner.cancel()
    try:
        await runner
    except asyncio.CancelledError:
        pass


def _run_menu() -> None:
    global _MENU_ACTIVE
    _MENU_ACTIVE = True

    def _render_shell_header() -> list[str]:
        version = _agent_version()
        title = [
            " __  __  ____ ____      _    ____ ____ ___ ____ _____ _    _   _ _____ ",
            "|  \\/  |/ ___|  _ \\    / \\  / ___/ ___|_ _/ ___|_   _/ \\  | \\ | |_   _|",
            "| |\\/| | |   | |_) |  / _ \\ \\___ \\___ \\| |\\___ \\ | |/ _ \\ |  \\| | | |  ",
            "| |  | | |___|  __/  / ___ \\ ___) |__) | | ___) || / ___ \\| |\\  | | |  ",
            "|_|  |_|\\____|_|    /_/   \\_\\____/____/___|____/ |_/_/   \\_\\_| \\_| |_|  ",
            f"                   {APP_TITLE}  v{version}",
            "",
            "Tips:",
            "1. Use /help to list commands.",
            "2. Use /show to inspect current config.",
            "3. Use /set <key> <value> for quick updates.",
            "4. Use /run to launch the bridge.",
            "",
        ]
        return title

    def _status_lines(cfg_path: Any) -> list[str]:
        current = load_config_file(cfg_path)
        cwd_label = f"{os.path.basename(os.getcwd()) or os.getcwd()}  menu  {cfg_path}"
        lines = [cwd_label]
        token = str(current.get("jwt_token", "")).strip()
        profile = current.get("auth_profile", {}) if isinstance(current.get("auth_profile", {}), dict) else {}
        if token:
            subject = str(profile.get("subject") or current.get("subject") or "").strip()
            email = str(profile.get("email") or "").strip()
            auth_mode = str(profile.get("mode") or "jwt").strip()
            profile_line = f"[auth] Logged in via {auth_mode}: {subject}" + (f" ({email})" if email else "")
            lines.append(profile_line)
        else:
            lines.append("[auth] Not logged in. Use /login oauth (or /login jwt) before /run.")
        lines.append("")
        return lines

    def _capture_output(fn: Any) -> list[str]:
        buffer = StringIO()
        with redirect_stdout(buffer):
            fn()
        text = buffer.getvalue().strip("\n")
        return text.splitlines() if text else []

    def _print_shell_header(cfg_path: Any) -> None:
        header = _render_shell_header()
        _console(_gradient_style("\n".join(header[:6]), (255, 64, 64), (255, 255, 255), bold=True))
        for line in header[6:]:
            _console(_style(line, color="37"))
        for line in _status_lines(cfg_path):
            color = "36"
            bold = False
            if line.startswith("[auth]") and "Not logged in" in line:
                color = "33"
                bold = True
            elif line.startswith("[auth]"):
                color = "32"
            elif " menu " in line:
                color = "90"
            _console(_style(line, color=color, bold=bold))

    def _set_value_from_menu(cfg_path: Any, key: str, value: str) -> None:
        normalized = key.strip().lower().replace("-", "_")
        if normalized not in {"subject", "jwt_token", "remote_server_base_url", "websocket_url", "request_timeout_seconds"}:
            _console(_style(f"Unsupported key: {key}", color="31", bold=True))
            return
        update: dict[str, Any]
        if normalized == "request_timeout_seconds":
            try:
                update = {normalized: max(1.0, float(value))}
            except ValueError:
                _console(_style("request_timeout_seconds must be a number.", color="31", bold=True))
                return
        else:
            update = {normalized: value}
        save_config_updates(update, cfg_path)
        _console(_style(f"Updated {normalized}.", color="32", bold=True))

    if not sys.stdin.isatty():
        _console(_style("Interactive menu requires a TTY. Run in a terminal session.", color="31", bold=True))
        raise SystemExit(1)

    history: list[str] = []
    logs_follow = False
    log_cursor = 0
    rendered_history_cursor = 0
    bridge_stop_event: Event | None = None
    bridge_thread: Thread | None = None
    bridge_running_reported = False

    def _bridge_is_running() -> bool:
        return bridge_thread is not None and bridge_thread.is_alive()

    def _flush_log_buffer(force: bool = False) -> None:
        nonlocal log_cursor
        if not logs_follow and not force:
            return
        with _MENU_LOG_LOCK:
            snapshot = list(_MENU_LOG_BUFFER)
        if log_cursor > len(snapshot):
            log_cursor = 0
        new_lines = snapshot[log_cursor:]
        log_cursor = len(snapshot)
        if not new_lines:
            return
        for line in new_lines[-60:]:
            history.append(f"[log] {line}")

    def _print_history_delta() -> None:
        nonlocal rendered_history_cursor
        if rendered_history_cursor > len(history):
            rendered_history_cursor = 0
        for line in history[rendered_history_cursor:]:
            color = "37"
            if line.startswith("Unknown command"):
                color = "31"
            elif line.startswith(">>>"):
                color = "35"
            elif line.startswith("[log]"):
                color = "90"
            _console(_style(line, color=color))
        rendered_history_cursor = len(history)

    def _start_bridge_in_background() -> None:
        nonlocal bridge_stop_event, bridge_thread, bridge_running_reported
        stop_event = Event()

        def _worker() -> None:
            try:
                with redirect_stdout(sys.stdout), redirect_stderr(sys.stderr):
                    asyncio.run(_run_menu_bridge_until_stopped(stop_event))
            except Exception as exc:
                _console(_style(f"[run] bridge stopped with error: {exc}", color="31", bold=True))

        bridge_stop_event = stop_event
        bridge_thread = Thread(target=_worker, daemon=True)
        bridge_thread.start()
        bridge_running_reported = True

    cfg_path = resolve_config_path()
    _print_shell_header(cfg_path)
    while True:
        _flush_log_buffer()
        if bridge_running_reported and not _bridge_is_running():
            history.append("Bridge stopped. Use /run to start again.")
            bridge_running_reported = False
        cfg_path = resolve_config_path()
        _print_history_delta()
        raw = _menu_input_box_fixed()
        if not raw:
            continue
        history.append(f">>> {raw}")

        if raw in {"/run", "run"}:
            current = load_config_file(cfg_path)
            if not str(current.get("jwt_token", "")).strip():
                history.append("Please run /login oauth (or /login jwt) before /run.")
                continue
            if _bridge_is_running():
                history.append("Gateway is already running. Use /stop to stop it.")
                continue
            history.append("Starting gateway in background. Use /stop to stop.")
            _start_bridge_in_background()
            continue
        if raw in {"/stop", "stop"}:
            if _bridge_is_running() and bridge_stop_event is not None:
                bridge_stop_event.set()
                history.append("Stopping gateway...")
                continue
            history.append("Gateway is not running.")
            continue
        if raw in {"/exit", "/quit", "exit", "quit"}:
            if _bridge_is_running() and bridge_stop_event is not None:
                bridge_stop_event.set()
            raise SystemExit(0)
        if raw in {"/help", "help"}:
            history.extend([
                "Commands:",
                "  /help                  Show this command list",
                "  /clear                 Clear screen",
                "  /show                  Show current config JSON",
                "  /path                  Show resolved config path",
                "  /init                  Create config if missing",
                "  /settings              Open interactive settings editor",
                "  /login [oauth|jwt] [minutes]  Login and save JWT in config",
                "  /logout                Revoke token (best effort) and clear local JWT",
                "  /set <key> <value>     Update one config key",
                "  /run                   Start gateway",
                "  /stop                  Stop gateway",
                "  /logs on|off|show      Monitor verbose logs",
                "  /exit                  Exit menu",
            ])
            continue
        if raw.startswith("/logs") or raw.startswith("logs"):
            parts = raw.split()
            if len(parts) == 1 or (len(parts) > 1 and parts[1].lower() == "on"):
                logs_follow = True
                log_cursor = 0
                logging.getLogger().setLevel(logging.DEBUG)
                logger.setLevel(logging.DEBUG)
                history.append("Live logs enabled. Use /logs off to disable.")
                continue
            if len(parts) > 1 and parts[1].lower() == "off":
                logs_follow = False
                logging.getLogger().setLevel(logging.INFO)
                logger.setLevel(logging.INFO)
                history.append("Live logs disabled.")
                continue
            if len(parts) > 1 and parts[1].lower() == "show":
                _flush_log_buffer(force=True)
                history.append("Displayed buffered logs.")
                continue
            history.append("Usage: /logs on|off|show")
            continue
        if raw in {"/show", "show"}:
            history.extend(_capture_output(_print_config_json))
            continue
        if raw in {"/clear", "clear", "/cls", "cls"}:
            history.clear()
            continue
        if raw in {"/path", "path"}:
            history.append(str(cfg_path))
            continue
        if raw in {"/init", "init"}:
            history.extend(_capture_output(lambda: _console(_style(f"Config ready at {ensure_default_config(cfg_path)}", color="32", bold=True))))
            continue
        if raw in {"/settings", "settings"}:
            _interactive_settings_editor()
            history.append("Settings updated.")
            continue
        if raw.startswith("/login") or raw.startswith("login"):
            parts = raw.split()
            login_mode = "oauth"
            expiry: int | None = None
            if len(parts) > 1 and parts[1].lower() in {"oauth", "jwt"}:
                login_mode = parts[1].lower()
                parts = [parts[0], *parts[2:]]
            elif len(parts) == 1:
                login_mode = _select_login_mode_interactive()
                if login_mode == "back":
                    continue
            if len(parts) > 1:
                try:
                    expiry = int(parts[1])
                except ValueError:
                    history.append("Usage: /login [oauth|jwt] [expiry_minutes]")
                    continue
            _menu_login(cfg_path, mode=login_mode, expiry_minutes=expiry)
            history.append("Login flow completed.")
            continue
        if raw in {"/logout", "logout"}:
            history.extend(_capture_output(lambda: _menu_logout(cfg_path)))
            continue
        if raw.startswith("/set ") or raw.startswith("set "):
            try:
                parts = shlex.split(raw[1:] if raw.startswith("/") else raw)
            except ValueError as exc:
                history.append(f"Invalid command format: {exc}")
                continue
            if len(parts) < 3:
                history.append("Usage: /set <key> <value>")
                continue
            key = parts[1]
            value = " ".join(parts[2:])
            history.extend(_capture_output(lambda: _set_value_from_menu(cfg_path, key, value)))
            continue

        history.append(f"Unknown command: {raw}")


def _handle_non_run_command(args: argparse.Namespace) -> bool:
    if args.command == "config":
        _apply_cli_overrides(args)
        if args.config_command == "path":
            _console(str(resolve_config_path()))
            return True
        if args.config_command == "show":
            _print_config_json()
            return True
        if args.config_command == "init":
            path = ensure_default_config(resolve_config_path())
            _console(_style(f"Config ready at {path}", color="32", bold=True))
            return True
        if args.config_command == "set":
            updates = _config_updates_from_args(args)
            if not updates:
                _console(_style("No config values provided.", color="33", bold=True))
                return True
            path = save_config_updates(updates, resolve_config_path())
            _console(_style(f"Saved settings to {path}", color="32", bold=True))
            return True
    if args.command == "settings":
        _apply_cli_overrides(args)
        _interactive_settings_editor()
        return True
    if args.command == "menu":
        _apply_cli_overrides(args)
        _run_menu()
        return True
    return False


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
        _log("bridge", f"starting: websocket={self.config.websocket_url} subject={self.config.subject}", color="32", bold=True)
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
            register_msg = {"type": "register", "subject": self.config.subject, "capabilities": announced_servers}
            await websocket.send(json.dumps(register_msg))
            _log("bridge", f"connected and registered mcp_servers={','.join(announced_servers)}", color="32", bold=True)
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
                _log("url", f"{name} -> {urls['mcp']}", color="36")

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
        new_subject = _derive_subject_from_token(token)
        updates = {"jwt_token": token}
        if new_subject:
            self.config.subject = new_subject
            os.environ["SUBJECT"] = new_subject
            updates["subject"] = new_subject
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


async def _main(show_runtime_header: bool = True) -> None:
    configure_logging()
    if show_runtime_header:
        _print_runtime_header()
    config = _load_config_with_prompt()
    _print_config_tip(config)
    _console(_style(_frame([f"Subject: {config.subject}", f"WebSocket: {config.websocket_url}"]), color="32", bold=True))
    _log("boot", f"loaded config: subject={config.subject} websocket={config.websocket_url}", color="36")
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
    args = _parse_cli_args()
    if _handle_non_run_command(args):
        return
    _apply_cli_overrides(args)
    try:
        asyncio.run(_main(show_runtime_header=True))
    except ConnectionClosed:
        logger.info("connection closed")


if __name__ == "__main__":
    cli()









