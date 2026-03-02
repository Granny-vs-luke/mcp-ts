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
        jwt_all_servers = st.checkbox("All MCP servers (*)", value=False)
        jwt_mcp_server = st.text_input("MCP server name", value="filesystem")
        jwt_expiry_minutes = st.number_input("Expiry (minutes)", min_value=1, max_value=1440, value=60, step=5)
        if st.button("Generate JWT"):
            if not jwt_secret.strip():
                st.error("JWT secret is required.")
            else:
                capabilities = ["*"] if jwt_all_servers else ([jwt_mcp_server.strip()] if jwt_mcp_server.strip() else [])
                subject = _generate_agent_id(10)
                payload = {
                    "sub": subject,
                    "role": "agent",
                    "capabilities": capabilities,
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
