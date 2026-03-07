from __future__ import annotations

import json
import os
import hashlib
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import jwt
from dotenv import load_dotenv

DEFAULT_REMOTE_SERVER_BASE_URL = "https://hub.linkos.in/agent"
CONFIG_KEY_ORDER = [
    "subject",
    "jwt_token",
    "refresh_token",
    "remote_server_base_url",
    "websocket_url",
    "published_endpoints",
    "request_timeout_seconds",
    "reconnect_initial_delay_seconds",
    "reconnect_max_delay_seconds",
    "auto_discover_local_mcp",
    "discovery_candidates",
    "capabilities",
    "local_capability_endpoints",
    "mcpServers",
]


@dataclass
class AgentConfig:
    subject: str
    websocket_url: str
    jwt_token: str
    capabilities: list[str]
    local_capability_endpoints: dict[str, str]
    mcp_servers: dict[str, dict] | None = None
    auto_discover_local_mcp: bool = True
    discovery_candidates: list[str] | None = None
    reconnect_initial_delay_seconds: float = 1.0
    reconnect_max_delay_seconds: float = 20.0
    request_timeout_seconds: float = 20.0


def _ws_url_from_base(base_url: str) -> str:
    normalized = base_url.rstrip("/")
    if normalized.startswith("https://"):
        return "wss://" + normalized.removeprefix("https://") + "/connect"
    if normalized.startswith("http://"):
        return "ws://" + normalized.removeprefix("http://") + "/connect"
    return normalized + "/connect"


def _decode_unverified_claims(token: str) -> dict:
    return jwt.decode(token, options={"verify_signature": False, "verify_exp": False})


def _derive_subject(token: str, claims: dict[str, Any] | None = None) -> str:
    if claims:
        sub = str(claims.get("sub", "")).strip()
        if sub:
            return sub
        for key in ("subject", "sub", "jti", "iss"):
            value = str(claims.get(key, "")).strip()
            if value:
                return f"subject-{value}"
    digest = hashlib.sha256(token.encode("utf-8")).hexdigest()[:12]
    return f"subject-{digest}"


def _get_env(primary: str, fallback: str, default: str = "") -> str:
    return os.getenv(primary, os.getenv(fallback, default))


def _parse_bool(value: str | bool | None, default: bool) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    normalized = str(value).strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    return default


def _load_config_file(path: Path) -> dict:
    if not path.exists():
        return {}
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def _ordered_config(data: dict[str, Any]) -> dict[str, Any]:
    ordered: dict[str, Any] = {}
    for key in CONFIG_KEY_ORDER:
        if key in data:
            ordered[key] = data[key]
    for key, value in data.items():
        if key not in ordered:
            ordered[key] = value
    return ordered


def _default_config_template() -> dict[str, Any]:
    return _ordered_config({
        "remote_server_base_url": DEFAULT_REMOTE_SERVER_BASE_URL,
        "mcpServers": {
            "filesystem": {
                "command": "npx",
                "args": [
                    "@modelcontextprotocol/server-filesystem",
                    str(Path.cwd().resolve()),
                ],
            }
        },
    })


def ensure_default_config(path: Path | None = None) -> Path:
    target = path or _resolve_config_path()
    if target.exists():
        return target
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open("w", encoding="utf-8") as handle:
        json.dump(_default_config_template(), handle, indent=2)
        handle.write("\n")
    return target


def _load_env_files() -> None:
    cwd = Path.cwd().resolve()
    module_dir = Path(__file__).resolve().parent
    candidates: list[Path] = [cwd / ".env", module_dir / ".env"]
    candidates.extend(parent / ".env" for parent in cwd.parents)
    candidates.extend(parent / ".env" for parent in module_dir.parents)
    seen: set[Path] = set()
    for candidate in candidates:
        resolved = candidate.resolve()
        if resolved in seen:
            continue
        seen.add(resolved)
        if candidate.exists():
            load_dotenv(candidate, override=False)


def _resolve_config_path() -> Path:
    env_path = os.getenv("AGENT_CONFIG_PATH")
    if env_path:
        return Path(env_path)

    cwd = Path.cwd().resolve()
    module_dir = Path(__file__).resolve().parent
    candidates = [cwd / "config.json", module_dir / "config.json"]
    candidates.extend(parent / "config.json" for parent in cwd.parents)
    candidates.extend(parent / "config.json" for parent in module_dir.parents)
    for candidate in candidates:
        if candidate.exists():
            return candidate
    return cwd / "config.json"


def resolve_config_path() -> Path:
    return _resolve_config_path()


def _is_local_ws(url: str) -> bool:
    try:
        parsed = urlparse(url)
        host = (parsed.hostname or "").lower()
        return host in {"127.0.0.1", "localhost", "::1"}
    except Exception:
        return False


def load_config() -> AgentConfig:
    _load_env_files()
    cfg_path = _resolve_config_path()
    ensure_default_config(cfg_path)
    file_cfg = _load_config_file(cfg_path)

    file_identity = str(file_cfg.get("subject", ""))
    subject = _get_env("SUBJECT", "subject", file_identity)
    resolved_subject = subject
    websocket_url = _get_env("REMOTE_WEBSOCKET_URL", "remote_websocket_url", str(file_cfg.get("websocket_url", "")))
    jwt_token = _get_env("AGENT_JWT", "agent_jwt", str(file_cfg.get("jwt_token", "")))
    remote_base_url = _get_env(
        "REMOTE_SERVER_BASE_URL",
        "remote_server_base_url",
        str(file_cfg.get("remote_server_base_url", DEFAULT_REMOTE_SERVER_BASE_URL)),
    )

    capabilities = file_cfg.get("capabilities", [])
    if os.getenv("CAPABILITIES"):
        capabilities = [item.strip() for item in os.getenv("CAPABILITIES", "").split(",") if item.strip()]

    if not websocket_url and remote_base_url:
        websocket_url = _ws_url_from_base(remote_base_url)

    if jwt_token:
        try:
            claims = _decode_unverified_claims(jwt_token)
        except Exception as exc:
            raise RuntimeError("AGENT_JWT is not a valid JWT format") from exc
        if not resolved_subject:
            resolved_subject = _derive_subject(jwt_token, claims)
        if not capabilities:
            capabilities = [str(item) for item in claims.get("capabilities", [])]

    endpoints = file_cfg.get("local_capability_endpoints", {})
    mcp_servers_raw = file_cfg.get("mcpServers", file_cfg.get("mcp_servers", {}))
    mcp_servers = mcp_servers_raw if isinstance(mcp_servers_raw, dict) else {}
    if not endpoints and mcp_servers:
        for server_name, server_cfg in mcp_servers.items():
            if not isinstance(server_cfg, dict):
                continue
            capability = str(server_name)
            endpoint = str(server_cfg.get("url", "")).strip()
            if not endpoint:
                port = server_cfg.get("port")
                if port is not None:
                    endpoint = f"http://127.0.0.1:{int(port)}/mcp"
            if endpoint:
                endpoints[capability] = endpoint
    if not capabilities and mcp_servers:
        capabilities = [str(name) for name in mcp_servers.keys()]
    if not capabilities and isinstance(endpoints, dict):
        capabilities = [str(item) for item in endpoints.keys()]
    auto_discover = _parse_bool(os.getenv("AUTO_DISCOVER_LOCAL_MCP", file_cfg.get("auto_discover_local_mcp", True)), True)
    candidates_raw = os.getenv("MCP_DISCOVERY_CANDIDATES", file_cfg.get("discovery_candidates", []))
    if isinstance(candidates_raw, str):
        discovery_candidates = [item.strip() for item in candidates_raw.split(",") if item.strip()]
    elif isinstance(candidates_raw, list):
        discovery_candidates = [str(item).strip() for item in candidates_raw if str(item).strip()]
    else:
        discovery_candidates = []

    reconnect_initial = float(os.getenv("RECONNECT_INITIAL_DELAY_SECONDS", file_cfg.get("reconnect_initial_delay_seconds", 1.0)))
    reconnect_max = float(os.getenv("RECONNECT_MAX_DELAY_SECONDS", file_cfg.get("reconnect_max_delay_seconds", 20.0)))
    request_timeout = float(os.getenv("REQUEST_TIMEOUT_SECONDS", file_cfg.get("request_timeout_seconds", 20.0)))

    if not websocket_url:
        raise RuntimeError("Missing REMOTE_WEBSOCKET_URL/REMOTE_SERVER_BASE_URL")
    if not jwt_token:
        raise RuntimeError("Missing AGENT_JWT. Local bridge requires AGENT_JWT token explicitly.")
    if not resolved_subject:
        resolved_subject = _derive_subject(jwt_token, {})

    if websocket_url.startswith("ws://") and not _is_local_ws(websocket_url):
        raise RuntimeError("REMOTE_WEBSOCKET_URL must use wss:// in production")

    if not isinstance(endpoints, dict):
        raise RuntimeError("local_capability_endpoints must be an object")
    if not endpoints and not auto_discover:
        raise RuntimeError("Provide local_capability_endpoints or enable AUTO_DISCOVER_LOCAL_MCP=true")

    return AgentConfig(
        subject=resolved_subject,
        websocket_url=websocket_url,
        jwt_token=jwt_token,
        capabilities=capabilities,
        local_capability_endpoints={str(k): str(v) for k, v in endpoints.items()},
        mcp_servers={str(k): v for k, v in mcp_servers.items()},
        auto_discover_local_mcp=auto_discover,
        discovery_candidates=discovery_candidates,
        reconnect_initial_delay_seconds=max(0.2, reconnect_initial),
        reconnect_max_delay_seconds=max(reconnect_initial, reconnect_max),
        request_timeout_seconds=max(1.0, request_timeout),
    )


def load_config_file(path: Path | None = None) -> dict[str, Any]:
    target = path or _resolve_config_path()
    return _load_config_file(target)


def save_config_updates(updates: dict[str, Any], path: Path | None = None) -> Path:
    target = path or _resolve_config_path()
    existing = _load_config_file(target)
    merged = existing if isinstance(existing, dict) else {}
    merged.update(updates)
    ordered = _ordered_config(merged)
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open("w", encoding="utf-8") as handle:
        json.dump(ordered, handle, indent=2)
        handle.write("\n")
    return target
