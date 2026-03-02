from __future__ import annotations

import os
import secrets
import string
import sys
import time
from pathlib import Path
from typing import Any

import httpx
import jwt
import streamlit as st
from dotenv import load_dotenv
from streamlit.web import cli as stcli

load_dotenv()


def _generate_agent_id(length: int = 10) -> str:
    alphabet = string.ascii_uppercase + string.digits
    return "".join(secrets.choice(alphabet) for _ in range(max(1, min(length, 10))))


def _base_url() -> str:
    return os.getenv("REMOTE_PUBLIC_BASE_URL", "http://127.0.0.1:8000").rstrip("/")


def _ws_url(http_base_url: str) -> str:
    if http_base_url.startswith("https://"):
        return "wss://" + http_base_url.removeprefix("https://") + "/connect"
    if http_base_url.startswith("http://"):
        return "ws://" + http_base_url.removeprefix("http://") + "/connect"
    return http_base_url + "/connect"


def _get_agents(http_base_url: str, token: str, timeout_seconds: float) -> list[dict[str, Any]]:
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    with httpx.Client(timeout=timeout_seconds) as client:
        response = client.get(f"{http_base_url}/agents/details", headers=headers)
        response.raise_for_status()
        data = response.json()
        return data.get("agents", [])


def _post_mcp(http_base_url: str, agent_id: str, mcp_server: str, token: str, timeout_seconds: float, payload: dict[str, Any]) -> dict[str, Any]:
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    with httpx.Client(timeout=timeout_seconds) as client:
        response = client.post(f"{http_base_url}/{agent_id}/{mcp_server}/mcp", headers=headers, json=payload)
        response.raise_for_status()
        data = response.json()
        return data if isinstance(data, dict) else {"data": data}


def _fetch_mcp_server_info(http_base_url: str, agent_id: str, mcp_server: str, token: str, timeout_seconds: float) -> dict[str, Any]:
    try:
        initialize_payload = {
            "jsonrpc": "2.0",
            "id": "init-1",
            "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "mcp-remote-dashboard", "version": "1.0.0"},
            },
        }
        init_response = _post_mcp(http_base_url, agent_id, mcp_server, token, timeout_seconds, initialize_payload)
        init_result = init_response.get("result", init_response)
        server_info = init_result.get("serverInfo", {}) if isinstance(init_result, dict) else {}
        instructions = init_result.get("instructions", "") if isinstance(init_result, dict) else ""

        tools_payload = {"jsonrpc": "2.0", "id": "tools-1", "method": "tools/list", "params": {}}
        tools_response = _post_mcp(http_base_url, agent_id, mcp_server, token, timeout_seconds, tools_payload)
        tools_result = tools_response.get("result", tools_response)
        tools = tools_result.get("tools", []) if isinstance(tools_result, dict) else []

        return {
            "status": "✅ connected",
            "server_name": mcp_server,
            "title": str(server_info.get("title", "")),
            "version": str(server_info.get("version", "")),
            "tools_count": len(tools) if isinstance(tools, list) else 0,
            "tools": tools if isinstance(tools, list) else [],
            "instructions": str(instructions),
        }
    except Exception as exc:
        return {
            "status": "❌ error",
            "server_name": mcp_server,
            "title": "",
            "version": "",
            "tools_count": 0,
            "tools": [],
            "instructions": str(exc),
        }


def app() -> None:
    st.set_page_config(page_title="MCP Remote Dashboard", layout="wide")
    st.title("MCP Remote Server Dashboard")

    with st.sidebar:
        st.header("Remote API")
        http_base_url = st.text_input("Public base URL", value=_base_url())
        auth_token = st.text_input("Agent JWT", value=os.getenv("DASHBOARD_JWT", ""), type="password")
        timeout_seconds = st.number_input("API timeout (seconds)", min_value=1.0, max_value=60.0, value=10.0, step=1.0)
        refresh = st.button("Refresh")

        st.divider()
        st.header("JWT Generator")
        jwt_secret = st.text_input("JWT secret", value=os.getenv("JWT_SECRET", ""), type="password")
        jwt_algorithm = st.text_input("JWT algorithm", value=os.getenv("JWT_ALGORITHM", "HS256"))
        st.caption("Agent ID is auto-generated: max 10 chars, uppercase letters and numbers only.")
        jwt_expiry_minutes = st.number_input("Expiry (minutes)", min_value=1, max_value=1440, value=60, step=5)
        if st.button("Generate JWT"):
            if not jwt_secret.strip():
                st.error("JWT secret is required.")
            else:
                subject = _generate_agent_id(10)
                payload = {
                    "sub": subject,
                    "role": "agent",
                    "capabilities": ["*"],
                    "exp": int(time.time()) + int(jwt_expiry_minutes) * 60,
                }
                st.session_state["generated_jwt"] = jwt.encode(
                    payload,
                    jwt_secret.strip(),
                    algorithm=jwt_algorithm.strip() or "HS256",
                )
                st.session_state["generated_sub"] = subject
                st.success("JWT generated.")
        generated = st.session_state.get("generated_jwt", "")
        generated_sub = st.session_state.get("generated_sub", "")
        if generated_sub:
            st.caption(f"Generated token sub: `{generated_sub}`")
        if generated:
            st.text_area("Generated JWT", value=generated, height=140)
            if st.button("Use Generated JWT in Agent JWT"):
                st.session_state["selected_jwt"] = generated

    auth_token = st.session_state.get("selected_jwt", auth_token)

    if refresh or "agents_cache" not in st.session_state:
        try:
            st.session_state["agents_cache"] = _get_agents(http_base_url, auth_token, timeout_seconds)
            st.session_state["agents_error"] = ""
        except Exception as exc:
            st.session_state["agents_cache"] = []
            st.session_state["agents_error"] = str(exc)

    agents = st.session_state.get("agents_cache", [])
    error = st.session_state.get("agents_error", "")

    st.subheader("Connection URLs")
    st.code(f"Local agent WebSocket URL: {_ws_url(http_base_url)}", language="text")
    transport = st.selectbox("Transport", options=["streamable-http", "sse"], index=0)

    if error:
        st.error(f"Failed to fetch connected agents: {error}")
        return

    if not agents:
        st.info("No connected agents.")
        return

    st.subheader("Connected agents and MCP invoke URLs")
    rows: list[dict[str, str]] = []
    for agent in agents:
        agent_id = str(agent.get("agent_id", ""))
        capabilities = list(agent.get("capabilities", []))
        if not capabilities:
            rows.append(
                {
                    "agent_id": agent_id,
                    "mcp_server": "",
                    "invoke_url": f"{http_base_url}/{agent_id}/<mcp_server>/{'mcp' if transport == 'streamable-http' else 'sse'}",
                }
            )
            continue
        for capability in capabilities:
            suffix = "mcp" if transport == "streamable-http" else "sse"
            rows.append(
                {
                    "agent_id": agent_id,
                    "mcp_server": str(capability),
                    "invoke_url": f"{http_base_url}/{agent_id}/{capability}/{suffix}",
                }
            )
    st.dataframe(rows, use_container_width=True)

    st.subheader("MCP Server Info")
    if st.button("Refresh MCP Server Info"):
        info_rows: list[dict[str, Any]] = []
        for agent in agents:
            agent_id = str(agent.get("agent_id", ""))
            mcp_servers = list(agent.get("capabilities", []))
            for mcp_server in mcp_servers:
                row = _fetch_mcp_server_info(
                    http_base_url=http_base_url,
                    agent_id=agent_id,
                    mcp_server=str(mcp_server),
                    token=auth_token,
                    timeout_seconds=timeout_seconds,
                )
                row["agent_id"] = agent_id
                info_rows.append(row)
        st.session_state["mcp_server_info_rows"] = info_rows

    info_rows = st.session_state.get("mcp_server_info_rows", [])
    for item in info_rows:
        status = str(item.get("status", ""))
        agent_id = str(item.get("agent_id", ""))
        server_name = str(item.get("server_name", ""))
        title = str(item.get("title", ""))
        version = str(item.get("version", ""))
        tools_count = int(item.get("tools_count", 0))
        instructions = str(item.get("instructions", ""))
        tools = item.get("tools", [])

        header = f"{status} {agent_id} / {server_name} ({tools_count} tools)"
        with st.expander(header, expanded=False):
            st.write(f"**Agent ID:** `{agent_id}`")
            st.write(f"**MCP Server:** `{server_name}`")
            st.write(f"**Title:** `{title or '-'} `")
            st.write(f"**Version:** `{version or '-'} `")
            st.write(f"**Instructions:** {instructions or '-'}")
            st.markdown("**Tools**")
            if isinstance(tools, list) and tools:
                for tool in tools:
                    name = str((tool or {}).get("name", ""))
                    description = str((tool or {}).get("description", ""))
                    st.write(f"- `{name}`: {description}")
            else:
                st.write("- None")

    st.caption("Use these URLs in your MCP client integration layer with an agent JWT scoped to the MCP server.")


def run() -> None:
    dashboard_file = Path(__file__).resolve()
    host = os.getenv("DASHBOARD_HOST", "0.0.0.0")
    port = os.getenv("DASHBOARD_PORT", "8501")
    sys.argv = [
        "streamlit",
        "run",
        str(dashboard_file),
        "--server.address",
        host,
        "--server.port",
        str(port),
    ]
    raise SystemExit(stcli.main())


if __name__ == "__main__":
    app()
