from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import shlex
import signal
import time
import sys
from collections import deque
from threading import Event, Lock, Thread
from contextlib import redirect_stderr, redirect_stdout
from importlib.metadata import PackageNotFoundError, version as pkg_version
from io import StringIO
from typing import Any

if os.name == "nt":
    import ctypes

try:
    from prompt_toolkit import PromptSession
    from prompt_toolkit.patch_stdout import patch_stdout as PTPatchStdout
    from prompt_toolkit.styles import Style as PTStyle
except Exception:  # pragma: no cover - prompt_toolkit optional
    PromptSession = None  # type: ignore[assignment]
    PTPatchStdout = None  # type: ignore[assignment]
    PTStyle = None  # type: ignore[assignment]

import httpx
import jwt
from websockets.exceptions import ConnectionClosed

from .bridge_runtime import LocalBridgeAgent
from .cli_args import apply_cli_overrides, config_updates_from_args, parse_cli_args
from .cli_auth import AuthMenuService
from .config import AgentConfig, ensure_default_config, load_config, load_config_file, resolve_config_path, save_config_updates


def configure_logging() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s", stream=sys.stdout, force=True)
    for handler in logging.getLogger().handlers:
        if isinstance(handler, logging.StreamHandler):
            handler.setLevel(logging.INFO)
    logging.getLogger("websockets").setLevel(logging.INFO)
    logging.getLogger("websockets.client").setLevel(logging.INFO)
    logging.getLogger("asyncio").setLevel(logging.INFO)
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
_WINDOWS_ANSI_ENABLED: bool | None = None


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
        return _enable_windows_ansi()
    term = os.getenv("TERM", "").lower()
    return term not in {"", "dumb"}


def _enable_windows_ansi() -> bool:
    global _WINDOWS_ANSI_ENABLED
    if os.name != "nt":
        return True
    if _WINDOWS_ANSI_ENABLED is not None:
        return _WINDOWS_ANSI_ENABLED
    try:
        kernel32 = ctypes.windll.kernel32  # type: ignore[attr-defined]
        stdout = kernel32.GetStdHandle(-11)  # STD_OUTPUT_HANDLE
        mode = ctypes.c_uint32()
        if kernel32.GetConsoleMode(stdout, ctypes.byref(mode)) == 0:
            _WINDOWS_ANSI_ENABLED = False
            return False
        ENABLE_VIRTUAL_TERMINAL_PROCESSING = 0x0004
        new_mode = mode.value | ENABLE_VIRTUAL_TERMINAL_PROCESSING
        if kernel32.SetConsoleMode(stdout, new_mode) == 0:
            _WINDOWS_ANSI_ENABLED = False
            return False
        _WINDOWS_ANSI_ENABLED = True
        return True
    except Exception:
        _WINDOWS_ANSI_ENABLED = False
        return False


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


def _display_subject(subject: str) -> str:
    value = (subject or "").strip()
    return value[-10:] if len(value) > 10 else value


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


def _manage_base_url_from_current(current: dict[str, Any]) -> str:
    base = str(current.get("remote_server_base_url", "")).strip()
    if base:
        return base.rstrip("/")
    ws = str(current.get("websocket_url", "")).strip()
    if ws.startswith("wss://"):
        return "https://" + ws.removeprefix("wss://").removesuffix("/connect")
    if ws.startswith("ws://"):
        return "http://" + ws.removeprefix("ws://").removesuffix("/connect")
    return ""


def _refresh_jwt_from_config(
    cfg_path: Any,
    *,
    on_message: Any | None = None,
) -> tuple[str, str] | None:
    current = load_config_file(cfg_path)
    refresh_token = str(current.get("refresh_token", "")).strip()
    if not refresh_token:
        return None
    base = _manage_base_url_from_current(current)
    if not base:
        return None
    endpoint = f"{base}/manage/oauth/refresh"
    try:
        response = httpx.post(endpoint, json={"refresh_token": refresh_token}, timeout=20.0)
    except Exception as exc:
        if on_message:
            on_message(f"JWT refresh failed: {exc}")
        return None
    if response.status_code in {404, 405, 503}:
        return None
    if response.status_code >= 400:
        if on_message:
            on_message(f"JWT refresh rejected (HTTP {response.status_code}).")
        return None
    body = response.json() if response.headers.get("content-type", "").startswith("application/json") else {}
    token = str(body.get("token", "")).strip() if isinstance(body, dict) else ""
    subject = str(body.get("subject", "")).strip() if isinstance(body, dict) else ""
    if not token:
        if on_message:
            on_message("JWT refresh response missing token.")
        return None
    updates: dict[str, Any] = {"jwt_token": token}
    if subject:
        updates["subject"] = subject
    maybe_refresh = str(body.get("refresh_token", "")).strip() if isinstance(body, dict) else ""
    if maybe_refresh:
        updates["refresh_token"] = maybe_refresh
    email = str(body.get("email", "")).strip() if isinstance(body, dict) else ""
    updates["auth_profile"] = {"mode": "oauth", "subject": subject or str(current.get("subject", "")).strip(), "email": email}
    save_config_updates(updates, cfg_path)
    os.environ["AGENT_JWT"] = token
    if subject:
        os.environ["SUBJECT"] = subject
    if on_message:
        on_message("JWT refreshed from OAuth session.")
    return token, subject or str(current.get("subject", "")).strip()


def _load_config_with_prompt() -> AgentConfig:
    while True:
        try:
            return load_config()
        except RuntimeError as exc:
            message = str(exc)
            updates: dict[str, str] = {}

            token = _token_from_sources()
            if "AGENT_JWT is not a valid JWT format" in message:
                refreshed = _refresh_jwt_from_config(resolve_config_path(), on_message=lambda m: _console(_style(m, color="36", bold=True)))
                if refreshed:
                    continue
                _console(_style("Current AGENT_JWT is invalid.", color="31", bold=True))
                token = _prompt_for_token()
                updates["jwt_token"] = token
                os.environ["AGENT_JWT"] = token
                new_subject = _derive_subject_from_token(token)
                if new_subject:
                    updates["subject"] = new_subject
                    os.environ["SUBJECT"] = new_subject
            elif "Missing AGENT_JWT" in message:
                refreshed = _refresh_jwt_from_config(resolve_config_path(), on_message=lambda m: _console(_style(m, color="36", bold=True)))
                if refreshed:
                    continue
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
    return parse_cli_args()


def _apply_cli_overrides(args: argparse.Namespace) -> None:
    apply_cli_overrides(args)


def _config_updates_from_args(args: argparse.Namespace) -> dict[str, Any]:
    return config_updates_from_args(args)


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


def _bridge_on_log(tag: str, message: str) -> None:
    color = "36"
    if tag == "bridge":
        color = "32"
    elif tag == "mcp":
        color = "35"
    elif tag == "url":
        color = "36"
    elif tag == "boot":
        color = "33"
    _log(tag, message, color=color, bold=False)


_AUTH_MENU: AuthMenuService | None = None


def _auth_menu() -> AuthMenuService:
    global _AUTH_MENU
    if _AUTH_MENU is None:
        _AUTH_MENU = AuthMenuService(
            style=_style,
            console=_console,
            supports_color=_supports_color,
            derive_subject_from_token=_derive_subject_from_token,
        )
    return _AUTH_MENU


def _select_login_mode_interactive() -> str:
    return _auth_menu().select_login_mode_interactive()


def _menu_login(cfg_path: Any, mode: str = "oauth", expiry_minutes: int | None = None) -> None:
    _auth_menu().login(cfg_path, mode=mode, expiry_minutes=expiry_minutes)


def _menu_logout(cfg_path: Any) -> None:
    _auth_menu().logout(cfg_path)


def _menu_input_box_fixed() -> str:
    global _MENU_PROMPT_SESSION, _MENU_PROMPT_STYLE
    if PromptSession is not None and PTStyle is not None and sys.stdin.isatty() and sys.stdout.isatty():
        if _MENU_PROMPT_SESSION is None:
            _MENU_PROMPT_SESSION = PromptSession()
            _MENU_PROMPT_STYLE = PTStyle.from_dict(
                {
                    "prompt": "ansired bold",
                }
            )

        if PTPatchStdout is not None:
            with PTPatchStdout():
                raw = _MENU_PROMPT_SESSION.prompt(
                    [("class:prompt", "mcp > ")],
                    style=_MENU_PROMPT_STYLE,
                )
        else:
            raw = _MENU_PROMPT_SESSION.prompt(
                [("class:prompt", "mcp > ")],
                style=_MENU_PROMPT_STYLE,
            )
        return raw.strip()

    raw = input(_style("mcp > ", color="31", bold=True)).strip()
    return raw


async def _run_menu_bridge_until_stopped(stop_event: Event) -> None:
    config = load_config()
    _print_config_tip(config)
    short_subject = _display_subject(config.subject)
    _console(_style(_frame([f"Subject: {short_subject}", f"WebSocket: {config.websocket_url}"]), color="32", bold=True))
    _log("boot", f"loaded config: subject={short_subject} websocket={config.websocket_url}", color="36")
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

    agent = LocalBridgeAgent(
        config,
        on_log=_bridge_on_log,
        prompt_for_token=_prompt_for_token,
        derive_subject=_derive_subject_from_token,
        persist_updates=_persist_updates,
        refresh_jwt=lambda: _refresh_jwt_from_config(resolve_config_path()),
        enable_spinner=False,
    )
    runner = asyncio.create_task(agent.run())
    while not stop_event.is_set():
        await asyncio.sleep(0.1)
    _log("boot", "stop requested from menu. closing bridge...", color="33", bold=True)
    await agent.stop()
    runner.cancel()
    try:
        await runner
    except asyncio.CancelledError:
        pass


def _run_menu() -> None:
    configure_logging()

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
            "4. Use /start to launch the bridge.",
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
            profile_line = f"[auth] Logged in via {auth_mode}: {_display_subject(subject)}" + (f" ({email})" if email else "")
            lines.append(profile_line)
            published = current.get("published_endpoints")
            if isinstance(published, dict) and published:
                for server_name, urls in published.items():
                    if not isinstance(urls, dict):
                        continue
                    mcp_url = str(urls.get("mcp", "")).strip()
                    if mcp_url:
                        lines.append(f"[url] {server_name} -> {mcp_url}")
        else:
            lines.append("[auth] Not logged in. Use /login oauth (or /login jwt) before /start.")
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
            elif line.startswith("[url]"):
                color = "36"
            elif " menu " in line:
                color = "90"
            _console(_style(line, color=color, bold=bold))

    def _clear_terminal() -> None:
        if os.name == "nt":
            os.system("cls")
        else:
            os.system("clear")

    def _set_value_from_menu(cfg_path: Any, key: str, value: str) -> None:
        normalized = key.strip().lower().replace("-", "_")
        if normalized not in {"subject", "jwt_token", "refresh_token", "remote_server_base_url", "websocket_url", "request_timeout_seconds"}:
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

    def _ensure_start_auth_ready(cfg_path: Any) -> bool:
        while True:
            current = load_config_file(cfg_path)
            token = str(current.get("jwt_token", "")).strip()
            if token:
                try:
                    claims = jwt.decode(token, options={"verify_signature": False, "verify_exp": False})
                    exp = int(claims.get("exp", 0) or 0)
                    if exp and time.time() >= exp - 15:
                        refreshed = _refresh_jwt_from_config(cfg_path, on_message=lambda m: history.append(m))
                        if refreshed:
                            continue
                except Exception:
                    pass
            try:
                load_config()
                return True
            except RuntimeError as exc:
                message = str(exc)
                if "AGENT_JWT is not a valid JWT format" in message or "Missing AGENT_JWT" in message:
                    refreshed = _refresh_jwt_from_config(cfg_path, on_message=lambda m: history.append(m))
                    if refreshed:
                        continue
                    history.append("JWT is missing/invalid. Paste a valid token to continue /start.")
                    token = _prompt_for_token().strip()
                    if not token:
                        history.append("Token entry cancelled.")
                        return False
                    updates: dict[str, str] = {"jwt_token": token}
                    os.environ["AGENT_JWT"] = token
                    subject = _derive_subject_from_token(token).strip()
                    if subject:
                        updates["subject"] = subject
                        os.environ["SUBJECT"] = subject
                    save_config_updates(updates, cfg_path)
                    history.append("Token saved. Re-validating configuration...")
                    continue
                history.append(f"/start failed: {message}")
                return False

    if not sys.stdin.isatty():
        _console(_style("Interactive menu requires a TTY. Run in a terminal session.", color="31", bold=True))
        raise SystemExit(1)

    history: list[str] = []
    logs_follow = False
    log_cursor = 0
    rendered_history_cursor = 0
    live_log_cursor = 0
    live_log_stop_event: Event | None = None
    live_log_thread: Thread | None = None
    bridge_stop_event: Event | None = None
    bridge_thread: Thread | None = None
    bridge_running_reported = False
    bridge_ready_event: Event | None = None

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

    def _start_live_logs() -> None:
        nonlocal live_log_cursor, live_log_stop_event, live_log_thread
        if live_log_thread is not None and live_log_thread.is_alive():
            return
        with _MENU_LOG_LOCK:
            live_log_cursor = len(_MENU_LOG_BUFFER)
        live_log_stop_event = Event()

        def _worker() -> None:
            nonlocal live_log_cursor
            while live_log_stop_event is not None and not live_log_stop_event.is_set():
                with _MENU_LOG_LOCK:
                    snapshot = list(_MENU_LOG_BUFFER)
                if live_log_cursor > len(snapshot):
                    live_log_cursor = 0
                new_lines = snapshot[live_log_cursor:]
                live_log_cursor = len(snapshot)
                for line in new_lines:
                    if " mcp_local_agent " not in line:
                        continue
                    _console(line)
                time.sleep(0.12)

        live_log_thread = Thread(target=_worker, daemon=True)
        live_log_thread.start()

    def _stop_live_logs() -> None:
        nonlocal live_log_stop_event, live_log_thread
        if live_log_stop_event is not None:
            live_log_stop_event.set()
        if live_log_thread is not None and live_log_thread.is_alive():
            live_log_thread.join(timeout=1.0)
        live_log_stop_event = None
        live_log_thread = None


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
        nonlocal bridge_stop_event, bridge_thread, bridge_running_reported, bridge_ready_event
        stop_event = Event()
        ready_event = Event()
        bridge_ready_event = ready_event

        def _worker() -> None:
            try:
                with redirect_stdout(sys.stdout), redirect_stderr(sys.stderr):
                    async def _run() -> None:
                        config = load_config()
                        _print_config_tip(config)
                        short_subject = _display_subject(config.subject)
                        _console(_style(_frame([f"Subject: {short_subject}", f"WebSocket: {config.websocket_url}"]), color="32", bold=True))
                        _log("boot", f"loaded config: subject={short_subject} websocket={config.websocket_url}", color="36")
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
                        agent = LocalBridgeAgent(
                            config,
                            on_log=_bridge_on_log,
                            prompt_for_token=_prompt_for_token,
                            derive_subject=_derive_subject_from_token,
                            persist_updates=_persist_updates,
                            refresh_jwt=lambda: _refresh_jwt_from_config(cfg_path),
                            enable_spinner=True,
                            on_registered=ready_event.set,
                        )
                        runner = asyncio.create_task(agent.run())
                        while not stop_event.is_set():
                            await asyncio.sleep(0.1)
                        _log("boot", "stop requested from menu. closing bridge...", color="33", bold=True)
                        await agent.stop()
                        runner.cancel()
                        try:
                            await runner
                        except asyncio.CancelledError:
                            pass

                    asyncio.run(_run())
            except Exception as exc:
                _console(_style(f"[run] bridge stopped with error: {exc}", color="31", bold=True))

        bridge_stop_event = stop_event
        bridge_thread = Thread(target=_worker, daemon=True)
        bridge_thread.start()
        bridge_running_reported = True

    cfg_path = resolve_config_path()
    _print_shell_header(cfg_path)
    while True:
        try:
            if not logs_follow:
                _flush_log_buffer()
            if bridge_running_reported and not _bridge_is_running():
                history.append("Bridge stopped. Use /start to start again.")
                bridge_running_reported = False
            cfg_path = resolve_config_path()
            _print_history_delta()
            raw = _menu_input_box_fixed()
            if not raw:
                continue
        except (KeyboardInterrupt, EOFError):
            _stop_live_logs()
            if _bridge_is_running() and bridge_stop_event is not None:
                bridge_stop_event.set()
                if bridge_thread is not None and bridge_thread.is_alive():
                    bridge_thread.join(timeout=5.0)
            raise SystemExit(0)

        if raw in {"/start", "start"}:
            if not _ensure_start_auth_ready(cfg_path):
                continue
            if _bridge_is_running():
                history.append("Gateway is already running. Use /stop to stop it.")
                continue
            history.append("Starting gateway in background. Use /stop to stop.")
            _start_bridge_in_background()
            if bridge_ready_event is not None:
                while not bridge_ready_event.is_set():
                    time.sleep(0.05)
            continue
        if raw in {"/stop", "stop"}:
            if _bridge_is_running() and bridge_stop_event is not None:
                bridge_stop_event.set()
                history.append("Stopping gateway...")
                continue
            history.append("Gateway is not running.")
            continue
        if raw in {"/exit", "/quit", "exit", "quit"}:
            _stop_live_logs()
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
                "  /start                 Start gateway",
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
                logger.setLevel(logging.DEBUG)
                logging.getLogger("websockets").setLevel(logging.INFO)
                logging.getLogger("websockets.client").setLevel(logging.INFO)
                logging.getLogger("asyncio").setLevel(logging.INFO)
                _start_live_logs()
                history.append("Live logs enabled. Use /logs off to disable.")
                continue
            if len(parts) > 1 and parts[1].lower() == "off":
                logs_follow = False
                logger.setLevel(logging.INFO)
                logging.getLogger("websockets").setLevel(logging.INFO)
                logging.getLogger("websockets.client").setLevel(logging.INFO)
                logging.getLogger("asyncio").setLevel(logging.INFO)
                _stop_live_logs()
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
            rendered_history_cursor = 0
            _clear_terminal()
            _print_shell_header(cfg_path)
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


async def _main(show_runtime_header: bool = True) -> None:
    configure_logging()
    if show_runtime_header:
        _print_runtime_header()
    config = _load_config_with_prompt()
    _print_config_tip(config)
    short_subject = _display_subject(config.subject)
    _console(_style(_frame([f"Subject: {short_subject}", f"WebSocket: {config.websocket_url}"]), color="32", bold=True))
    _log("boot", f"loaded config: subject={short_subject} websocket={config.websocket_url}", color="36")
    _log("boot", f"mcpServers keys: {list((config.mcp_servers or {}).keys())}", color="36")
    try:
        claims = jwt.decode(config.jwt_token, options={"verify_signature": False, "verify_exp": False})
        _log("boot", "jwt summary: sub=%s role=%s mcp_servers=%s" % (claims.get("sub", ""), claims.get("role", ""), len(claims.get("capabilities", []) or [])), color="36")
    except Exception:
        _log("boot", "unable to parse AGENT_JWT claims", color="33")

    agent = LocalBridgeAgent(
        config,
        on_log=_bridge_on_log,
        prompt_for_token=_prompt_for_token,
        derive_subject=_derive_subject_from_token,
        persist_updates=_persist_updates,
        refresh_jwt=lambda: _refresh_jwt_from_config(resolve_config_path()),
        enable_spinner=True,
    )
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
    configure_logging()
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









