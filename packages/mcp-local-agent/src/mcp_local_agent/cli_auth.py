from __future__ import annotations

import queue
import socket
import sys
import time
import webbrowser
import secrets
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
from typing import Any, Callable
from urllib.parse import parse_qs, urlparse
from uuid import uuid4

import httpx

from .config import DEFAULT_REMOTE_SERVER_BASE_URL, load_config_file, save_config_updates


class AuthMenuService:
    """Interactive auth service used by CLI menu commands (/login, /logout)."""

    def __init__(
        self,
        *,
        style: Callable[..., str],
        console: Callable[[str], None],
        supports_color: Callable[[], bool],
        derive_subject_from_token: Callable[[str], str],
    ) -> None:
        self._style = style
        self._console = console
        self._supports_color = supports_color
        self._derive_subject_from_token = derive_subject_from_token

    def select_login_mode_interactive(self) -> str:
        """Render keyboard-driven login mode selection for menu users."""
        try:
            import msvcrt  # type: ignore
        except Exception:
            msvcrt = None
        options: list[tuple[str, str]] = [
            ("oauth", "Continue with Google (MCP Assistant Web)"),
            ("jwt", "JWT fallback (manual subject token issue)"),
            ("back", "Back"),
        ]
        if msvcrt is not None and sys.stdin.isatty() and sys.stdout.isatty():
            selected = 0
            rendered_lines = 0
            while True:
                if rendered_lines > 0:
                    if self._supports_color():
                        print(f"\x1b[{rendered_lines}F", end="")
                        for _ in range(rendered_lines):
                            print("\x1b[2K", end="")
                            print("\x1b[1E", end="")
                        print(f"\x1b[{rendered_lines}F", end="")
                    else:
                        self._console("")
                self._console(self._style("Select login mode (Up/Down/PageUp/PageDown + Enter, Esc to go back):", color="34", bold=True))
                for idx, (_, label) in enumerate(options):
                    prefix = "> " if idx == selected else "  "
                    color = "32" if idx == selected else "37"
                    self._console(self._style(f"{prefix}{label}", color=color, bold=(idx == selected)))
                rendered_lines = 1 + len(options)
                key = msvcrt.getwch()
                if key in {"\r", "\n"}:
                    return options[selected][0]
                if key == "\x1b":
                    return "back"
                if key in {"\x00", "\xe0"}:
                    ext = msvcrt.getwch()
                    if ext in {"H", "I"}:
                        selected = (selected - 1) % len(options)
                    elif ext in {"P", "Q"}:
                        selected = (selected + 1) % len(options)
                continue

        self._console(self._style("Login mode:", color="34", bold=True))
        self._console(self._style("1. Continue with Google (MCP Assistant Web)", color="37"))
        self._console(self._style("2. JWT fallback (manual subject token issue)", color="37"))
        self._console(self._style("3. Back", color="37"))
        while True:
            raw = input("Choose [1/2/3]: ").strip()
            if raw in {"1", "oauth", "OAuth", "OAUTH"}:
                return "oauth"
            if raw in {"2", "jwt", "JWT"}:
                return "jwt"
            if raw in {"3", "back", "Back", "BACK"}:
                return "back"
            self._console(self._style("Please enter 1, 2, or 3.", color="31", bold=True))

    def login(self, cfg_path: Any, mode: str = "oauth", expiry_minutes: int | None = None) -> None:
        """Run OAuth-first login flow and persist issued tokens in config."""
        current = load_config_file(cfg_path)
        base = self._menu_manage_base_url(current)
        if not base:
            self._console(self._style("remote_server_base_url is required for /login.", color="31", bold=True))
            return
        existing_token = str(current.get("jwt_token", "")).strip()
        if existing_token:
            self._console(self._style("Already logged in. Run /logout before /login again.", color="33", bold=True))
            return
        expiry = self._menu_prompt_expiry(expiry_minutes)
        if expiry is None:
            return
        subject = str(current.get("subject", "")).strip()
        if not subject:
            token = str(current.get("jwt_token") or current.get("agent_jwt") or "").strip()
            if token:
                subject = self._derive_subject_from_token(token)
        caps = self._menu_capabilities(current)
        if mode == "oauth":
            # OAuth mode must not inherit a stale/manual local subject from JWT mode.
            oauth_handled = self._menu_login_oauth(base=base, subject="", expiry=expiry, caps=caps, cfg_path=cfg_path)
            if oauth_handled:
                return
            self._console(self._style("OAuth endpoint unavailable. Falling back to legacy token issue.", color="33", bold=True))
        else:
            self._console(self._style("Using JWT fallback login mode.", color="33", bold=True))
        if not subject:
            subject = self._auto_subject()
            self._console(self._style(f"Using auto-generated subject: {subject}", color="34", bold=True))
        self._menu_login_legacy(base=base, subject=subject, expiry=expiry, caps=caps, cfg_path=cfg_path)

    def logout(self, cfg_path: Any) -> None:
        """Best-effort revoke both bridge JWT and OAuth refresh token."""
        current = load_config_file(cfg_path)
        token = str(current.get("jwt_token", "")).strip()
        refresh_token = str(current.get("refresh_token", "")).strip()
        if not token and not refresh_token:
            self._console(self._style("No jwt_token/refresh_token found in config.", color="33", bold=True))
            return
        base = self._menu_manage_base_url(current)
        if base and token:
            endpoint = f"{base}/manage/jwt/revoke"
            try:
                response = httpx.post(endpoint, json={"token": token}, timeout=20.0)
                if response.status_code >= 400:
                    self._console(self._style(f"/logout warning: revoke returned HTTP {response.status_code}", color="33", bold=True))
            except Exception as exc:
                self._console(self._style(f"/logout warning: revoke failed: {exc}", color="33", bold=True))
        if base and refresh_token:
            endpoint = f"{base}/manage/oauth/logout"
            try:
                response = httpx.post(endpoint, json={"refresh_token": refresh_token}, timeout=20.0)
                if response.status_code >= 400:
                    self._console(self._style(f"/logout warning: oauth logout returned HTTP {response.status_code}", color="33", bold=True))
            except Exception as exc:
                self._console(self._style(f"/logout warning: oauth logout failed: {exc}", color="33", bold=True))
        save_config_updates({"jwt_token": "", "refresh_token": "", "auth_profile": {}, "published_endpoints": {}}, cfg_path)
        self._console(self._style("Logout successful. jwt_token/refresh_token cleared from config.", color="32", bold=True))

    def _menu_manage_base_url(self, current: dict[str, Any]) -> str:
        base = str(current.get("remote_server_base_url", "")).strip()
        if base:
            return base.rstrip("/")
        ws = str(current.get("websocket_url", "")).strip()
        if ws.startswith("wss://"):
            return "https://" + ws.removeprefix("wss://").removesuffix("/connect")
        if ws.startswith("ws://"):
            return "http://" + ws.removeprefix("ws://").removesuffix("/connect")
        return DEFAULT_REMOTE_SERVER_BASE_URL.rstrip("/")

    def _menu_capabilities(self, current: dict[str, Any]) -> list[str]:
        configured = current.get("capabilities")
        if isinstance(configured, list) and configured:
            return [str(item) for item in configured if str(item).strip()]
        servers = current.get("mcpServers")
        if isinstance(servers, dict) and servers:
            return [str(name) for name in servers.keys()]
        return ["*"]

    def _menu_prompt_expiry(self, expiry_minutes: int | None = None) -> int | None:
        default_expiry = expiry_minutes if expiry_minutes is not None else 1440
        expiry_raw = input(f"Expiry minutes (leave empty for default {default_expiry}): ").strip()
        try:
            expiry = int(expiry_raw) if expiry_raw else int(default_expiry)
        except ValueError:
            self._console(self._style("Expiry minutes must be an integer.", color="31", bold=True))
            return None
        return max(1, expiry)

    def _auto_subject(self) -> str:
        """Generate a fresh 10-char unique subject for JWT fallback logins."""
        return secrets.token_hex(5)

    def _menu_login_legacy(self, base: str, subject: str, expiry: int, caps: list[str], cfg_path: Any) -> None:
        endpoint = f"{base}/manage/jwt/issue"
        try:
            response = httpx.post(endpoint, json={"subject": subject, "expiry_minutes": expiry, "capabilities": caps}, timeout=20.0)
            response.raise_for_status()
            payload = response.json()
        except Exception as exc:
            self._console(self._style(f"/login failed: {exc}", color="31", bold=True))
            return
        token = str(payload.get("token", "")).strip() if isinstance(payload, dict) else ""
        if not token:
            self._console(self._style("/login failed: token missing in response.", color="31", bold=True))
            return
        save_config_updates(
            {
                "subject": subject,
                "jwt_token": token,
                "refresh_token": "",
                "auth_profile": {"mode": "jwt", "subject": subject},
            },
            cfg_path,
        )
        self._console(self._style("Login successful (legacy JWT issue).", color="32", bold=True))

    def _find_local_callback_port(self) -> int | None:
        port = 43110
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                sock.bind(("127.0.0.1", port))
            except OSError:
                return None
        return port

    def _start_local_oauth_callback_server(
        self,
        port: int,
        callback_path: str,
    ) -> tuple[ThreadingHTTPServer, queue.Queue[dict[str, str]], Thread]:
        result_queue: queue.Queue[dict[str, str]] = queue.Queue(maxsize=1)

        class CallbackHandler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:  # noqa: N802
                parsed = urlparse(self.path)
                normalized_callback_path = callback_path.rstrip("/")
                if parsed.path.rstrip("/") != normalized_callback_path:
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
                    self.send_response(409)
                    self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
                    self.send_header("Pragma", "no-cache")
                    self.send_header("Expires", "0")
                    self.end_headers()
                    self.wfile.write(b"OAuth callback already consumed.")
                    return
                body = """<!doctype html><html lang='en'><head><meta charset='utf-8'/><meta name='viewport' content='width=device-width, initial-scale=1'/><title>MCP Assistant Login Successful</title><style>*{box-sizing:border-box}html,body{width:100%;height:100%;margin:0}body{display:flex;align-items:center;justify-content:center;background:#fff;color:#111;font-family:Segoe UI,Arial,sans-serif;text-align:center}.logo{width:56px;height:auto;margin:0 auto 10px;display:block}h2{margin:0 0 6px;font-size:1.35rem;font-weight:600}p{margin:0;color:#111;font-size:.98rem}.link{display:block;margin-top:8px;color:#111;text-decoration:underline}</style></head><body><main><img class='logo' src='https://mcp-assistant.in/logo.svg' alt='MCP Assistant'/><h2>Login successful!</h2><p>You can close the tab.</p><a class='link' href='https://mcp-assistant.in' target='_blank' rel='noreferrer noopener'>mcp-assistant.in</a></main></body></html>"""
                encoded = body.encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(encoded)))
                self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
                self.send_header("Pragma", "no-cache")
                self.send_header("Expires", "0")
                self.end_headers()
                self.wfile.write(encoded)

            def log_message(self, format: str, *args: Any) -> None:  # noqa: A003
                return

        server = ThreadingHTTPServer(("127.0.0.1", port), CallbackHandler)
        thread = Thread(target=server.serve_forever, daemon=True)
        thread.start()
        return server, result_queue, thread

    def _menu_login_oauth(self, base: str, subject: str, expiry: int, caps: list[str], cfg_path: Any) -> bool:
        callback_port = self._find_local_callback_port()
        if callback_port is None:
            self._console(self._style("/login failed: no free localhost callback port found.", color="31", bold=True))
            return True
        callback_path = f"/callback/{uuid4().hex}"
        callback_url = f"http://127.0.0.1:{callback_port}{callback_path}"
        callback_server, callback_queue, callback_thread = self._start_local_oauth_callback_server(callback_port, callback_path)
        start_endpoint = f"{base}/manage/oauth/start"
        try:
            start_resp = httpx.post(
                start_endpoint,
                json={"subject": subject, "expiry_minutes": expiry, "capabilities": caps, "redirect_uri": callback_url},
                timeout=20.0,
            )
        except Exception as exc:
            callback_server.shutdown(); callback_server.server_close(); callback_thread.join(timeout=2.0)
            self._console(self._style(f"/login failed: cannot reach OAuth start endpoint: {exc}", color="31", bold=True))
            return False
        if start_resp.status_code in {404, 405, 503}:
            callback_server.shutdown(); callback_server.server_close(); callback_thread.join(timeout=2.0)
            return False
        try:
            start_resp.raise_for_status()
            body = start_resp.json()
        except Exception as exc:
            callback_server.shutdown(); callback_server.server_close(); callback_thread.join(timeout=2.0)
            self._console(self._style(f"/login failed: OAuth start request failed: {exc}", color="31", bold=True))
            return True
        session_id = str(body.get("session_id", "")).strip()
        auth_url = str(body.get("auth_url", "")).strip()
        if not session_id or not auth_url:
            callback_server.shutdown(); callback_server.server_close(); callback_thread.join(timeout=2.0)
            self._console(self._style("/login failed: OAuth start response missing auth_url/session_id.", color="31", bold=True))
            return True
        redirect_to = (parse_qs(urlparse(auth_url).query).get("redirect_to") or [""])[0].strip()
        if not redirect_to or not redirect_to.startswith(callback_url):
            callback_server.shutdown(); callback_server.server_close(); callback_thread.join(timeout=2.0)
            self._console(self._style("/login failed: OAuth redirect mismatch. Retry /login.", color="31", bold=True))
            return True
        self._console(self._style("Opening browser for Supabase login (localhost callback)...", color="34", bold=True))
        self._console(self._style(f"Authorization URL: {auth_url}", color="37"))
        webbrowser.open(auth_url)
        self._console(self._style(f"Waiting for callback on {callback_url} ...", color="35"))
        callback: dict[str, str] | None = None
        deadline = time.time() + 300
        while time.time() < deadline:
            try:
                callback = callback_queue.get(timeout=1.0)
                break
            except queue.Empty:
                continue
        callback_server.shutdown(); callback_server.server_close(); callback_thread.join(timeout=2.0)
        if callback is None:
            self._console(self._style("/login timed out waiting for browser callback.", color="31", bold=True))
            return True
        error = callback.get("error", "").strip()
        if error:
            description = callback.get("error_description", "").strip()
            self._console(self._style(f"/login failed: {description or error}", color="31", bold=True))
            return True
        code = callback.get("code", "").strip()
        callback_session_id = callback.get("session_id", "").strip()
        if not code:
            self._console(self._style("/login failed: callback missing code.", color="31", bold=True))
            return True
        if callback_session_id and callback_session_id != session_id:
            self._console(self._style("/login failed: callback session mismatch.", color="31", bold=True))
            return True
        complete_endpoint = f"{base}/manage/oauth/complete"
        try:
            complete_resp = httpx.post(complete_endpoint, json={"session_id": session_id, "code": code}, timeout=20.0)
            complete_resp.raise_for_status()
            complete_body = complete_resp.json()
        except Exception as exc:
            self._console(self._style(f"/login failed: OAuth completion failed: {exc}", color="31", bold=True))
            return True
        token = str(complete_body.get("token", "")).strip() if isinstance(complete_body, dict) else ""
        oauth_subject = str(complete_body.get("subject", "")).strip() if isinstance(complete_body, dict) else ""
        if not token:
            self._console(self._style("/login failed: missing token in OAuth completion.", color="31", bold=True))
            return True
        save_config_updates(
            {
                "subject": oauth_subject or subject,
                "jwt_token": token,
                "refresh_token": str(complete_body.get("refresh_token", "")).strip() if isinstance(complete_body, dict) else "",
                "auth_profile": {
                    "mode": "oauth",
                    "subject": oauth_subject or subject,
                    "email": str(complete_body.get("email", "")).strip() if isinstance(complete_body, dict) else "",
                },
            },
            cfg_path,
        )
        self._console(self._style("Login successful (OAuth localhost callback). JWT saved to config.", color="32", bold=True))
        return True
