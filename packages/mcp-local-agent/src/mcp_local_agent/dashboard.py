from __future__ import annotations

import os
import sys
from pathlib import Path

import httpx
import streamlit as st
from dotenv import load_dotenv
from streamlit.web import cli as stcli

try:
    from .config import load_config
except ImportError:
    from mcp_local_agent.config import load_config

load_dotenv()


def _probe_endpoint(url: str, timeout: float) -> tuple[bool, str]:
    try:
        with httpx.Client(timeout=timeout) as client:
            response = client.get(url)
            return True, f"GET {response.status_code}"
    except Exception as get_exc:
        try:
            with httpx.Client(timeout=timeout) as client:
                response = client.post(url, json={})
                return True, f"POST {response.status_code}"
        except Exception as post_exc:
            return False, f"{type(get_exc).__name__}: {get_exc} | {type(post_exc).__name__}: {post_exc}"


def _discovery_candidates(config: object) -> list[str]:
    raw = list(getattr(config, "discovery_candidates", []) or [])
    mapped_endpoints = list(getattr(config, "local_capability_endpoints", {}).values())
    seen: set[str] = set()
    result: list[str] = []
    for url in [*raw, *mapped_endpoints]:
        value = str(url).strip()
        if not value or value in seen:
            continue
        seen.add(value)
        result.append(value)
    return result


def app() -> None:
    st.set_page_config(page_title="MCP Local Agent Dashboard", layout="wide")
    st.title("MCP Local Agent Dashboard")

    st.subheader("Resolved agent configuration")
    try:
        config = load_config()
        st.success("✅ Configuration loaded")
        st.code(
            "\n".join(
                [
                    f"AGENT_ID={config.agent_id}",
                    f"REMOTE_WEBSOCKET_URL={config.websocket_url}",
                    f"CAPABILITIES={','.join(config.capabilities)}",
                ]
            ),
            language="text",
        )
    except Exception as exc:
        st.error(f"Configuration load failed: {exc}")
        st.info("Set AGENT_JWT and REMOTE_SERVER_BASE_URL (or REMOTE_WEBSOCKET_URL), plus mcpServers/local_capability_endpoints in config.")
        return

    st.subheader("Connection URL")
    st.code(f"🔌 Agent connects to: {config.websocket_url}", language="text")

    st.subheader("Local capability endpoints")
    timeout = st.number_input("Probe timeout (seconds)", min_value=0.5, max_value=30.0, value=3.0, step=0.5)
    run_probe = st.button("Probe endpoints")

    rows: list[dict[str, str]] = []
    for capability, url in config.local_capability_endpoints.items():
        rows.append(
                {
                    "capability": capability,
                    "endpoint": url,
                    "status": "⏳ not checked",
                }
            )

    if run_probe:
        probed_rows: list[dict[str, str]] = []
        for capability, url in config.local_capability_endpoints.items():
            ok, details = _probe_endpoint(url, float(timeout))
            probed_rows.append(
                {
                    "capability": capability,
                    "endpoint": url,
                    "status": "✅ reachable" if ok else "❌ unreachable",
                    "details": details,
                }
            )
        st.dataframe(probed_rows, use_container_width=True)
    else:
        st.dataframe(rows, use_container_width=True)

    st.subheader("Discovery candidates")
    candidate_rows = [{"endpoint": url, "status": "⏳ not checked"} for url in _discovery_candidates(config)]
    probe_candidates = st.button("Probe discovery candidates")
    if probe_candidates:
        probed_candidates: list[dict[str, str]] = []
        for row in candidate_rows:
            endpoint = row["endpoint"]
            ok, details = _probe_endpoint(endpoint, float(timeout))
            probed_candidates.append(
                {
                    "endpoint": endpoint,
                    "status": "✅ reachable" if ok else "❌ unreachable",
                    "details": details,
                }
            )
        st.dataframe(probed_candidates, use_container_width=True)
    else:
        st.dataframe(candidate_rows, use_container_width=True)

    st.caption("Use `uv run mcp-local-agent` in a separate terminal to run the actual bridge process.")


def run() -> None:
    dashboard_file = Path(__file__).resolve()
    host = os.getenv("LOCAL_DASHBOARD_HOST", "0.0.0.0")
    port = os.getenv("LOCAL_DASHBOARD_PORT", "8502")
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
