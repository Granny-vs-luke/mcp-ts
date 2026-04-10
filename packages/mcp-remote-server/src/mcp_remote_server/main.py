from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from uuid import uuid4

import uvicorn
from fastapi import Depends, FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect, status
from fastapi.responses import HTMLResponse, JSONResponse, StreamingResponse
from dotenv import load_dotenv

from .auth import AuthContext, JWTAuthenticator, JWTFallbackService, RefreshSessionStore
from .connection_manager import ConnectionManager
from .models import (
    IssueTokenRequest,
    OAuthCompleteRequest,
    OAuthLogoutRequest,
    OAuthRefreshRequest,
    OAuthStartRequest,
    RevokeTokenRequest,
    RegisterMessage,
    ResultMessage,
)
from .oauth import SupabaseOAuthManager

load_dotenv()


def configure_logging() -> None:
    level = os.getenv("LOG_LEVEL", "INFO").upper()
    logging.basicConfig(level=level, format="%(asctime)s %(levelname)s %(name)s %(message)s")


configure_logging()
logger = logging.getLogger("mcp_remote_server")

app = FastAPI(title="MCP Remote Bridge", version="1.0.0")
authenticator = JWTAuthenticator()
connection_manager = ConnectionManager()
REQUEST_TIMEOUT_SECONDS = float(os.getenv("REQUEST_TIMEOUT_SECONDS", "20"))
ALLOW_UNAUTH_MCP_TRANSPORT = os.getenv("ALLOW_UNAUTH_MCP_TRANSPORT", "true").strip().lower() in {"1", "true", "yes", "on"}
oauth_manager = SupabaseOAuthManager()
jwt_fallback = JWTFallbackService(authenticator)
refresh_sessions = RefreshSessionStore()


def _header_value(request: Request, name: str) -> str:
    return str(request.headers.get(name, "")).strip()


def _should_trace_http(path: str) -> bool:
    return path.endswith("/mcp") or path.endswith("/sse") or path.startswith("/manage/")


@app.middleware("http")
async def trace_http_requests(request: Request, call_next: object) -> object:
    path = request.url.path
    if not _should_trace_http(path) or not logger.isEnabledFor(logging.DEBUG):
        return await call_next(request)  # type: ignore[misc]

    trace_id = str(uuid4())[:8]
    started = time.perf_counter()
    logger.debug(
        "http_trace_in trace_id=%s method=%s path=%s query=%s accept=%r content_type=%r user_agent=%r",
        trace_id,
        request.method,
        path,
        request.url.query,
        _header_value(request, "accept"),
        _header_value(request, "content-type"),
        _header_value(request, "user-agent"),
    )
    response = await call_next(request)  # type: ignore[misc]
    elapsed_ms = (time.perf_counter() - started) * 1000.0
    logger.debug(
        "http_trace_out trace_id=%s status=%s response_content_type=%r elapsed_ms=%.1f",
        trace_id,
        getattr(response, "status_code", "unknown"),
        str(getattr(response, "headers", {}).get("content-type", "")).strip(),
        elapsed_ms,
    )
    return response


@app.get("/healthz")
async def healthz() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/agents")
async def agents(auth_ctx: AuthContext = Depends(authenticator.http_auth)) -> dict[str, list[str]]:
    ids = await connection_manager.connected_subjects(owner_id=auth_ctx.subject)
    return {"connected_subjects": ids}


@app.get("/agents/details")
async def agent_details(auth_ctx: AuthContext = Depends(authenticator.http_auth)) -> dict[str, list[dict[str, object]]]:
    agents = await connection_manager.connected_agents_details(owner_id=auth_ctx.subject)
    return {"agents": agents}


@app.get("/manage/agents/details")
async def get_agents_details(subject: str = "") -> dict[str, list[dict[str, object]]]:
    owner_id = subject.strip()
    if not owner_id:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="subject is required")
    agents = await connection_manager.connected_agents_details(owner_id=owner_id)
    return {"agents": agents}


@app.get("/manage/agents/stream")
async def stream_agents_details(subject: str = "") -> StreamingResponse:
    owner_id = subject.strip()
    if not owner_id:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="subject is required")
    queue = await connection_manager.subscribe_agent_events(owner_id=owner_id)

    async def _stream() -> object:
        try:
            # Emit immediately so clients/proxies establish SSE framing without delay.
            yield ": connected\n\n"
            while True:
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=15.0)
                    yield f"event: {event.get('type', 'agents_updated')}\n"
                    yield f"data: {json.dumps(event)}\n\n"
                except TimeoutError:
                    # Keep long-lived proxies/browsers from closing idle SSE connections.
                    yield ": heartbeat\n\n"
        except asyncio.CancelledError:
            raise
        finally:
            await connection_manager.unsubscribe_agent_events(owner_id, queue)

    return StreamingResponse(
        _stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@app.post("/manage/jwt/issue")
async def issue_token(payload: IssueTokenRequest) -> dict[str, object]:
    return jwt_fallback.issue_token(
        subject=payload.subject,
        expiry_minutes=payload.expiry_minutes,
        capabilities=payload.capabilities,
    )


@app.post("/manage/jwt/revoke")
async def revoke_token(payload: RevokeTokenRequest) -> dict[str, bool]:
    return jwt_fallback.revoke_token(payload.token)


@app.get("/.well-known/oauth-protected-resource")
@app.get("/.well-known/oauth-protected-resource/{resource_path:path}")
async def oauth_protected_resource_metadata(resource_path: str = "") -> JSONResponse:
    resource = f"/{resource_path}" if resource_path else ""
    if oauth_manager.enabled:
        auth_server = oauth_manager.public_base_url or ""
        return JSONResponse(content={"resource": resource, "authorization_servers": [auth_server] if auth_server else []})
    return JSONResponse(content={"resource": resource, "authorization_servers": []})


@app.get("/.well-known/oauth-authorization-server")
async def oauth_authorization_server_metadata() -> JSONResponse:
    if oauth_manager.enabled:
        issuer = oauth_manager.public_base_url or ""
        return JSONResponse(
            content={
                "issuer": issuer,
                "authorization_endpoint": f"{issuer}/manage/oauth/start" if issuer else None,
                "token_endpoint": None,
            }
        )
    return JSONResponse(content={"authorization_endpoint": None, "token_endpoint": None, "issuer": None})


@app.get("/.well-known/openid-configuration")
async def openid_configuration() -> JSONResponse:
    return JSONResponse(content={"issuer": None, "authorization_endpoint": None, "token_endpoint": None})


@app.post("/manage/oauth/start")
async def oauth_start(payload: OAuthStartRequest, request: Request) -> dict[str, object]:
    base_url = str(request.base_url).rstrip("/")
    return await oauth_manager.start(
        request_base_url=base_url,
        subject=payload.subject,
        expiry_minutes=payload.expiry_minutes,
        capabilities=payload.capabilities,
        redirect_uri=payload.redirect_uri,
    )


@app.get("/manage/oauth/callback")
async def oauth_callback(session_id: str = "", code: str = "", error: str = "", error_description: str = "") -> HTMLResponse:
    safe_session_id = session_id.strip()
    if not safe_session_id:
        return HTMLResponse("<h2>OAuth failed</h2><p>Missing session_id.</p>", status_code=400)
    if error:
        reason = error_description or error
        await oauth_manager.fail(session_id=safe_session_id, reason=reason)
        return HTMLResponse(f"<h2>OAuth failed</h2><p>{reason}</p>", status_code=400)
    if not code:
        await oauth_manager.fail(session_id=safe_session_id, reason="Missing authorization code")
        return HTMLResponse("<h2>OAuth failed</h2><p>Missing authorization code.</p>", status_code=400)

    try:
        await oauth_manager.complete(
            session_id=safe_session_id,
            code=code.strip(),
            issue_bridge_token=jwt_fallback.issue_token_string,
        )
        html = """
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>MCP Assistant Login Complete</title>
    <style>
      * { box-sizing: border-box; }
      html, body { width: 100%; height: 100%; margin: 0; }
      body {
        display: flex;
        align-items: center;
        justify-content: center;
        background: #ffffff;
        color: #111111;
        font-family: Segoe UI, Arial, sans-serif;
        text-align: center;
      }
      main { padding: 14px; }
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
      <img class="logo" src="https://mcp-assistant.in/logo.svg" alt="MCP Assistant" />
      <h2>Login complete</h2>
      <p>You can return to the terminal now.</p>
    </main>
    <script>
      setTimeout(() => {
        try { window.close(); } catch (e) {}
      }, 1200);
    </script>
  </body>
</html>
"""
        return HTMLResponse(html)
    except HTTPException as exc:
        return HTMLResponse(f"<h2>OAuth failed</h2><p>{exc.detail}</p>", status_code=exc.status_code)
    except Exception as exc:
        return HTMLResponse(f"<h2>OAuth failed</h2><p>{exc}</p>", status_code=500)


@app.get("/manage/oauth/status")
async def oauth_status(session_id: str = "") -> dict[str, object]:
    safe_session_id = session_id.strip()
    if not safe_session_id:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="session_id is required")
    return await oauth_manager.status(safe_session_id)


@app.post("/manage/oauth/complete")
async def oauth_complete(payload: OAuthCompleteRequest) -> dict[str, object]:
    completed = await oauth_manager.complete(
        session_id=payload.session_id.strip(),
        code=payload.code.strip(),
        issue_bridge_token=jwt_fallback.issue_token_string,
    )
    refresh = await refresh_sessions.issue(
        subject=str(completed.get("subject", "")),
        email=str(completed.get("email", "")),
        capabilities=[str(item) for item in (completed.get("capabilities") or ["*"])],
        bridge_expiry_minutes=int(completed.get("expiry_minutes", 60) or 60),
    )
    return {
        "status": "complete",
        "token": str(completed.get("token", "")),
        "subject": str(completed.get("subject", "")),
        "email": str(completed.get("email", "")),
        "refresh_token": str(refresh.get("refresh_token", "")),
        "refresh_expires_at": int(refresh.get("refresh_expires_at", 0) or 0),
        "auth_mode": "oauth_refresh",
    }


@app.post("/manage/oauth/refresh")
async def oauth_refresh(payload: OAuthRefreshRequest) -> dict[str, object]:
    refreshed = await refresh_sessions.refresh(
        refresh_token=payload.refresh_token.strip(),
        expiry_minutes=payload.expiry_minutes,
        issue_bridge_token=jwt_fallback.issue_token_string,
    )
    return {
        "status": "ok",
        "token": str(refreshed.get("token", "")),
        "subject": str(refreshed.get("subject", "")),
        "email": str(refreshed.get("email", "")),
        "auth_mode": "oauth_refresh",
    }


@app.post("/manage/oauth/logout")
async def oauth_logout(payload: OAuthLogoutRequest) -> dict[str, bool]:
    revoked = await refresh_sessions.revoke(payload.refresh_token.strip())
    return {"revoked": revoked}


@app.websocket("/connect")
async def connect(websocket: WebSocket) -> None:
    try:
        auth_ctx = await authenticator.websocket_auth(websocket)
    except HTTPException:
        await websocket.close(code=4401, reason="unauthorized")
        return

    await websocket.accept()

    subject: str | None = None
    try:
        initial_raw = await websocket.receive_text()
        initial_obj = RegisterMessage.model_validate(json.loads(initial_raw))
        if initial_obj.subject != auth_ctx.subject:
            await websocket.close(code=4403, reason="subject mismatch")
            return

        declared_capabilities = set(initial_obj.capabilities)
        if "*" not in auth_ctx.capabilities and not declared_capabilities.issubset(auth_ctx.capabilities):
            await websocket.close(code=4403, reason="capability scope violation")
            return

        subject = initial_obj.subject
        await connection_manager.register(subject, auth_ctx.subject, websocket, declared_capabilities)

        while True:
            raw = await websocket.receive_text()
            message = json.loads(raw)
            msg_type = message.get("type")
            if msg_type == "result":
                result_msg = ResultMessage.model_validate(message)
                await connection_manager.handle_result(subject, result_msg.request_id, result_msg.result)
            else:
                logger.warning("unexpected_message_type", extra={"subject": subject, "type": msg_type})
    except WebSocketDisconnect:
        logger.info("agent_disconnected", extra={"subject": subject})
    except Exception:
        logger.exception("websocket_handler_error", extra={"subject": subject})
    finally:
        if subject:
            await connection_manager.unregister(subject, websocket)


async def _invoke_core(
    subject: str,
    mcp_server: str,
    payload: dict[str, object],
    auth_ctx: AuthContext,
) -> dict[str, object]:
    if auth_ctx.subject != subject:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Caller cannot access this agent")
    if mcp_server not in auth_ctx.capabilities and "*" not in auth_ctx.capabilities:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Caller missing MCP server scope")

    request_id = str(uuid4())
    method = str(payload.get("method", "")) if isinstance(payload, dict) else ""
    logger.debug(
        "invoke_core_dispatch request_id=%s subject=%s mcp_server=%s method=%s owner=%s",
        request_id,
        subject,
        mcp_server,
        method,
        auth_ctx.subject,
    )
    result = await connection_manager.invoke(
        subject=subject,
        mcp_server=mcp_server,
        payload=payload,
        request_id=request_id,
        timeout_seconds=REQUEST_TIMEOUT_SECONDS,
        owner_id=auth_ctx.subject,
    )
    return result


async def _get_mcp_server_info(subject: str, mcp_server: str, owner_id: str) -> dict[str, object]:
    request_id = str(uuid4())
    init_payload = {
        "jsonrpc": "2.0",
        "id": "init-1",
        "method": "initialize",
        "params": {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "remote-proxy-manager", "version": "1.0.0"},
        },
    }
    init_result = await connection_manager.invoke(
        subject=subject,
        mcp_server=mcp_server,
        payload=init_payload,
        request_id=request_id,
        timeout_seconds=REQUEST_TIMEOUT_SECONDS,
        owner_id=owner_id,
    )

    request_id_tools = str(uuid4())
    tools_payload = {"jsonrpc": "2.0", "id": "tools-1", "method": "tools/list", "params": {}}
    tools_result = await connection_manager.invoke(
        subject=subject,
        mcp_server=mcp_server,
        payload=tools_payload,
        request_id=request_id_tools,
        timeout_seconds=REQUEST_TIMEOUT_SECONDS,
        owner_id=owner_id,
    )

    init_data = init_result.get("result", init_result) if isinstance(init_result, dict) else {}
    tools_data = tools_result.get("result", tools_result) if isinstance(tools_result, dict) else {}
    server_info = init_data.get("serverInfo", {}) if isinstance(init_data, dict) else {}
    tools = tools_data.get("tools", []) if isinstance(tools_data, dict) else []

    return {
        "status": "connected",
        "subject": subject,
        "mcp_server": mcp_server,
        "title": str(server_info.get("title", "")),
        "version": str(server_info.get("version", "")),
        "instructions": str(init_data.get("instructions", "") if isinstance(init_data, dict) else ""),
        "tools_count": len(tools) if isinstance(tools, list) else 0,
        "tools": tools if isinstance(tools, list) else [],
    }


@app.post("/manage/{subject}/{mcp_server}/server-info")
async def get_mcp_server_info(
    subject: str,
    mcp_server: str,
    auth_ctx: AuthContext | None = Depends(authenticator.optional_http_auth),
) -> JSONResponse:
    if auth_ctx is not None and auth_ctx.subject != subject:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Caller cannot access this agent")
    try:
        data = await _get_mcp_server_info(subject=subject, mcp_server=mcp_server, owner_id=subject)
        return JSONResponse(content=data)
    except HTTPException as exc:
        return JSONResponse(
            status_code=exc.status_code,
            content={
                "status": "error",
                "subject": subject,
                "mcp_server": mcp_server,
                "title": "",
                "version": "",
                "instructions": exc.detail,
                "tools_count": 0,
                "tools": [],
            },
        )


@app.post("/{subject}/{mcp_server}/mcp")
async def invoke_capability_streamable_http(
    subject: str,
    mcp_server: str,
    request: Request,
    auth_ctx: AuthContext | None = Depends(authenticator.optional_http_auth),
) -> JSONResponse:
    # Streamable HTTP endpoint should always return JSON. Some clients send mixed
    # Accept headers including text/event-stream and then fail to parse SSE here.
    # Use /sse for event-stream responses.
    accept = _header_value(request, "accept")
    if "text/event-stream" in accept:
        logger.debug(
            "mcp_route_accept_mismatch path=%s accept=%r forcing='application/json'",
            request.url.path,
            accept,
        )
    result: dict[str, object] | None = None
    status_code = status.HTTP_200_OK
    try:
        if auth_ctx is None and not ALLOW_UNAUTH_MCP_TRANSPORT:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing bearer token")
        try:
            body = await request.json()
        except Exception as exc:
            logger.debug("mcp_route_bad_json path=%s error=%s", request.url.path, exc)
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid JSON request body") from exc
        payload = body.get("payload", body) if isinstance(body, dict) else {}
        logger.debug(
            "mcp_route_payload subject=%s mcp_server=%s payload_type=%s payload_keys=%s",
            subject,
            mcp_server,
            type(payload).__name__,
            sorted(list(payload.keys())) if isinstance(payload, dict) else [],
        )
        if auth_ctx is not None:
            result = await _invoke_core(subject=subject, mcp_server=mcp_server, payload=payload, auth_ctx=auth_ctx)
        else:
            request_id = str(uuid4())
            result = await connection_manager.invoke(
                subject=subject,
                mcp_server=mcp_server,
                payload=payload,
                request_id=request_id,
                timeout_seconds=REQUEST_TIMEOUT_SECONDS,
            )
    except HTTPException as exc:
        status_code = exc.status_code
        result = {"ok": False, "error": str(exc.detail)}
    except Exception as exc:
        status_code = status.HTTP_500_INTERNAL_SERVER_ERROR
        result = {"ok": False, "error": str(exc)}

    return JSONResponse(content=result or {}, status_code=status_code)


@app.get("/{subject}/{mcp_server}/mcp")
async def mcp_transport_info(subject: str, mcp_server: str, request: Request) -> JSONResponse:
    accept = _header_value(request, "accept")
    if "text/event-stream" in accept:
        logger.debug("mcp_get_sse_stream path=%s subject=%s mcp_server=%s", request.url.path, subject, mcp_server)

        async def _stream_transport() -> object:
            # Keep the stream open. Some clients treat the server as "disconnected"
            # if the optional GET SSE stream immediately closes.
            retry_ms = 10_000
            yield f"retry: {retry_ms}\n\n"
            yield "event: ready\ndata: {}\n\n"
            try:
                while True:
                    await asyncio.sleep(15)
                    # Comment line is ignored by SSE parsers and acts as a keep-alive.
                    yield f": keep-alive {time.time()}\n\n"
            except asyncio.CancelledError:
                return

        return StreamingResponse(
            _stream_transport(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache, no-transform",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )
    return JSONResponse(
        content={
            "transport": "streamable-http",
            "subject": subject,
            "mcp_server": mcp_server,
            "methods": ["POST"],
        }
    )


@app.post("/{subject}/{mcp_server}/sse")
async def invoke_capability_sse(
    subject: str,
    mcp_server: str,
    request: Request,
    auth_ctx: AuthContext | None = Depends(authenticator.optional_http_auth),
) -> StreamingResponse:
    if auth_ctx is None and not ALLOW_UNAUTH_MCP_TRANSPORT:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing bearer token")
    logger.debug(
        "sse_route_request subject=%s mcp_server=%s accept=%r content_type=%r",
        subject,
        mcp_server,
        _header_value(request, "accept"),
        _header_value(request, "content-type"),
    )
    try:
        body = await request.json()
    except Exception as exc:
        logger.debug("sse_route_bad_json path=%s error=%s", request.url.path, exc)
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid JSON request body") from exc
    payload = body.get("payload", body) if isinstance(body, dict) else {}
    if auth_ctx is not None:
        result_payload = await _invoke_core(subject=subject, mcp_server=mcp_server, payload=payload, auth_ctx=auth_ctx)
    else:
        request_id = str(uuid4())
        result_payload = await connection_manager.invoke(
            subject=subject,
            mcp_server=mcp_server,
            payload=payload,
            request_id=request_id,
            timeout_seconds=REQUEST_TIMEOUT_SECONDS,
        )

    async def _stream() -> object:
        yield f"event: result\ndata: {json.dumps(result_payload)}\n\n"
        yield "event: done\ndata: {}\n\n"

    return StreamingResponse(
        _stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


def run() -> None:
    host = os.getenv("HOST", "0.0.0.0")
    port = int(os.getenv("PORT", "8000"))
    uvicorn.run("mcp_remote_server.main:app", host=host, port=port)


if __name__ == "__main__":
    run()
