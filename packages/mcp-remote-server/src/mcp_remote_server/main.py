from __future__ import annotations

import asyncio
import json
import logging
import os
from uuid import uuid4

import uvicorn
from fastapi import Depends, FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect, status
from fastapi.responses import JSONResponse, StreamingResponse
from dotenv import load_dotenv

from .auth import AuthContext, JWTAuthenticator
from .connection_manager import ConnectionManager
from .models import IssueTokenRequest, RevokeTokenRequest, RegisterMessage, ResultMessage

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


@app.get("/healthz")
async def healthz() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/agents")
async def agents(auth_ctx: AuthContext = Depends(authenticator.http_auth)) -> dict[str, list[str]]:
    ids = await connection_manager.connected_agent_ids(owner_id=auth_ctx.subject)
    return {"connected_agents": ids}


@app.get("/agents/details")
async def agent_details(auth_ctx: AuthContext = Depends(authenticator.http_auth)) -> dict[str, list[dict[str, object]]]:
    agents = await connection_manager.connected_agents_details(owner_id=auth_ctx.subject)
    return {"agents": agents}


@app.get("/manage/agents/details")
async def get_agents_details(auth_ctx: AuthContext = Depends(authenticator.http_auth)) -> dict[str, list[dict[str, object]]]:
    agents = await connection_manager.connected_agents_details(owner_id=auth_ctx.subject)
    return {"agents": agents}


@app.get("/manage/agents/stream")
async def stream_agents_details(auth_ctx: AuthContext = Depends(authenticator.http_auth)) -> StreamingResponse:
    queue = await connection_manager.subscribe_agent_events(owner_id=auth_ctx.subject)

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
            await connection_manager.unsubscribe_agent_events(auth_ctx.subject, queue)

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
    token = authenticator.issue_agent_token(
        subject=payload.subject,
        expiry_minutes=payload.expiry_minutes,
        capabilities=payload.capabilities,
    )
    return {
        "token": token,
        "subject": payload.subject,
        "expiry_minutes": payload.expiry_minutes,
        "capabilities": payload.capabilities,
    }


@app.post("/manage/jwt/revoke")
async def revoke_token(payload: RevokeTokenRequest) -> dict[str, bool]:
    authenticator.revoke_token(payload.token)
    return {"revoked": True}


@app.get("/.well-known/oauth-protected-resource")
@app.get("/.well-known/oauth-protected-resource/{resource_path:path}")
async def oauth_protected_resource_metadata(resource_path: str = "") -> JSONResponse:
    # Explicitly advertise that this deployment doesn't require OAuth AS discovery.
    resource = f"/{resource_path}" if resource_path else ""
    return JSONResponse(content={"resource": resource, "authorization_servers": []})


@app.get("/.well-known/oauth-authorization-server")
async def oauth_authorization_server_metadata() -> JSONResponse:
    # No OAuth authorization server in this bridge deployment.
    return JSONResponse(content={"authorization_endpoint": None, "token_endpoint": None, "issuer": None})


@app.get("/.well-known/openid-configuration")
async def openid_configuration() -> JSONResponse:
    # No OIDC provider in this bridge deployment.
    return JSONResponse(content={"issuer": None, "authorization_endpoint": None, "token_endpoint": None})


@app.websocket("/connect")
async def connect(websocket: WebSocket) -> None:
    try:
        auth_ctx = await authenticator.websocket_auth(websocket)
    except HTTPException:
        await websocket.close(code=4401, reason="unauthorized")
        return

    await websocket.accept()

    agent_id: str | None = None
    try:
        initial_raw = await websocket.receive_text()
        initial_obj = RegisterMessage.model_validate(json.loads(initial_raw))
        if initial_obj.agent_id != auth_ctx.subject:
            await websocket.close(code=4403, reason="agent mismatch")
            return

        declared_capabilities = set(initial_obj.capabilities)
        if "*" not in auth_ctx.capabilities and not declared_capabilities.issubset(auth_ctx.capabilities):
            await websocket.close(code=4403, reason="capability scope violation")
            return

        agent_id = initial_obj.agent_id
        await connection_manager.register(agent_id, auth_ctx.subject, websocket, declared_capabilities)

        while True:
            raw = await websocket.receive_text()
            message = json.loads(raw)
            msg_type = message.get("type")
            if msg_type == "result":
                result_msg = ResultMessage.model_validate(message)
                await connection_manager.handle_result(agent_id, result_msg.request_id, result_msg.result)
            else:
                logger.warning("unexpected_message_type", extra={"agent_id": agent_id, "type": msg_type})
    except WebSocketDisconnect:
        logger.info("agent_disconnected", extra={"agent_id": agent_id})
    except Exception:
        logger.exception("websocket_handler_error", extra={"agent_id": agent_id})
    finally:
        if agent_id:
            await connection_manager.unregister(agent_id, websocket)


async def _invoke_core(
    agent_id: str,
    mcp_server: str,
    payload: dict[str, object],
    auth_ctx: AuthContext,
) -> dict[str, object]:
    if auth_ctx.subject != agent_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Caller cannot access this agent")
    if mcp_server not in auth_ctx.capabilities and "*" not in auth_ctx.capabilities:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Caller missing MCP server scope")

    request_id = str(uuid4())
    logger.info("invoke_request", extra={"agent_id": agent_id, "mcp_server": mcp_server, "request_id": request_id})
    result = await connection_manager.invoke(
        agent_id=agent_id,
        mcp_server=mcp_server,
        payload=payload,
        request_id=request_id,
        timeout_seconds=REQUEST_TIMEOUT_SECONDS,
        owner_id=auth_ctx.subject,
    )
    return result


async def _get_mcp_server_info(agent_id: str, mcp_server: str, owner_id: str) -> dict[str, object]:
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
        agent_id=agent_id,
        mcp_server=mcp_server,
        payload=init_payload,
        request_id=request_id,
        timeout_seconds=REQUEST_TIMEOUT_SECONDS,
        owner_id=owner_id,
    )

    request_id_tools = str(uuid4())
    tools_payload = {"jsonrpc": "2.0", "id": "tools-1", "method": "tools/list", "params": {}}
    tools_result = await connection_manager.invoke(
        agent_id=agent_id,
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
        "agent_id": agent_id,
        "mcp_server": mcp_server,
        "title": str(server_info.get("title", "")),
        "version": str(server_info.get("version", "")),
        "instructions": str(init_data.get("instructions", "") if isinstance(init_data, dict) else ""),
        "tools_count": len(tools) if isinstance(tools, list) else 0,
        "tools": tools if isinstance(tools, list) else [],
    }


@app.post("/manage/{agent_id}/{mcp_server}/server-info")
async def get_mcp_server_info(
    agent_id: str,
    mcp_server: str,
    auth_ctx: AuthContext = Depends(authenticator.http_auth),
) -> JSONResponse:
    if auth_ctx.subject != agent_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Caller cannot access this agent")
    try:
        data = await _get_mcp_server_info(agent_id=agent_id, mcp_server=mcp_server, owner_id=auth_ctx.subject)
        return JSONResponse(content=data)
    except HTTPException as exc:
        return JSONResponse(
            status_code=exc.status_code,
            content={
                "status": "error",
                "agent_id": agent_id,
                "mcp_server": mcp_server,
                "title": "",
                "version": "",
                "instructions": exc.detail,
                "tools_count": 0,
                "tools": [],
            },
        )


@app.post("/{agent_id}/{mcp_server}/mcp")
async def invoke_capability_streamable_http(
    agent_id: str,
    mcp_server: str,
    request: Request,
    auth_ctx: AuthContext | None = Depends(authenticator.optional_http_auth),
) -> JSONResponse:
    if auth_ctx is None and not ALLOW_UNAUTH_MCP_TRANSPORT:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing bearer token")
    body = await request.json()
    payload = body.get("payload", body) if isinstance(body, dict) else {}
    if auth_ctx is not None:
        result = await _invoke_core(agent_id=agent_id, mcp_server=mcp_server, payload=payload, auth_ctx=auth_ctx)
        return JSONResponse(content=result)
    request_id = str(uuid4())
    result = await connection_manager.invoke(
        agent_id=agent_id,
        mcp_server=mcp_server,
        payload=payload,
        request_id=request_id,
        timeout_seconds=REQUEST_TIMEOUT_SECONDS,
    )
    return JSONResponse(content=result)


@app.get("/{agent_id}/{mcp_server}/mcp")
async def mcp_transport_info(agent_id: str, mcp_server: str) -> JSONResponse:
    return JSONResponse(
        content={
            "transport": "streamable-http",
            "agent_id": agent_id,
            "mcp_server": mcp_server,
            "methods": ["POST"],
        }
    )


@app.post("/{agent_id}/{mcp_server}/sse")
async def invoke_capability_sse(
    agent_id: str,
    mcp_server: str,
    request: Request,
    auth_ctx: AuthContext | None = Depends(authenticator.optional_http_auth),
) -> StreamingResponse:
    if auth_ctx is None and not ALLOW_UNAUTH_MCP_TRANSPORT:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing bearer token")
    body = await request.json()
    payload = body.get("payload", body) if isinstance(body, dict) else {}
    if auth_ctx is not None:
        result_payload = await _invoke_core(agent_id=agent_id, mcp_server=mcp_server, payload=payload, auth_ctx=auth_ctx)
    else:
        request_id = str(uuid4())
        result_payload = await connection_manager.invoke(
            agent_id=agent_id,
            mcp_server=mcp_server,
            payload=payload,
            request_id=request_id,
            timeout_seconds=REQUEST_TIMEOUT_SECONDS,
        )

    async def _stream() -> object:
        yield f"event: result\ndata: {json.dumps(result_payload)}\n\n"
        yield "event: done\ndata: {}\n\n"

    return StreamingResponse(_stream(), media_type="text/event-stream")


def run() -> None:
    host = os.getenv("HOST", "0.0.0.0")
    port = int(os.getenv("PORT", "8000"))
    uvicorn.run("mcp_remote_server.main:app", host=host, port=port)


if __name__ == "__main__":
    run()
