from __future__ import annotations

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
from .models import RegisterMessage, ResultMessage

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
async def agents(_: AuthContext = Depends(authenticator.http_auth)) -> dict[str, list[str]]:
    ids = await connection_manager.connected_agent_ids()
    return {"connected_agents": ids}


@app.get("/agents/details")
async def agent_details(_: AuthContext = Depends(authenticator.http_auth)) -> dict[str, list[dict[str, object]]]:
    agents = await connection_manager.connected_agents_details()
    return {"agents": agents}


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
        if not declared_capabilities.issubset(auth_ctx.capabilities):
            await websocket.close(code=4403, reason="capability scope violation")
            return

        agent_id = initial_obj.agent_id
        await connection_manager.register(agent_id, websocket, declared_capabilities)

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
    )
    return result


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
