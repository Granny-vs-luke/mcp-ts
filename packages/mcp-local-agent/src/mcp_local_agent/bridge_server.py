from __future__ import annotations

import argparse
import asyncio
import json
import os
import signal
from pathlib import Path
from typing import Any


def _load_json(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def _derive_endpoint(name: str, server_cfg: dict[str, Any]) -> tuple[str, str]:
    capability = str(name)
    endpoint = str(server_cfg.get("url", "")).strip()
    if not endpoint and server_cfg.get("port") is not None:
        endpoint = f"http://127.0.0.1:{int(server_cfg['port'])}/mcp"
    return capability, endpoint


async def _pipe_output(stream: asyncio.StreamReader | None, prefix: str) -> None:
    if stream is None:
        return
    while True:
        line = await stream.readline()
        if not line:
            return
        print(f"[{prefix}] {line.decode(errors='replace').rstrip()}")


async def _spawn_server(name: str, server_cfg: dict[str, Any]) -> asyncio.subprocess.Process:
    command = str(server_cfg.get("command", "")).strip()
    if not command:
        raise RuntimeError(f"mcpServers.{name}.command is required")
    args = [str(item) for item in server_cfg.get("args", [])]
    env = os.environ.copy()
    env.update({str(k): str(v) for k, v in server_cfg.get("env", {}).items()})
    cwd = server_cfg.get("cwd")
    process = await asyncio.create_subprocess_exec(
        command,
        *args,
        cwd=str(cwd) if cwd else None,
        env=env,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    asyncio.create_task(_pipe_output(process.stdout, f"{name}:stdout"))
    asyncio.create_task(_pipe_output(process.stderr, f"{name}:stderr"))
    return process


async def _run(args: argparse.Namespace) -> None:
    cfg_path = Path(args.config).resolve()
    if not cfg_path.exists():
        raise RuntimeError(f"Config file not found: {cfg_path}")
    config = _load_json(cfg_path)
    servers = config.get("mcpServers")
    if not isinstance(servers, dict) or not servers:
        raise RuntimeError("Config must include non-empty object: mcpServers")

    selected: dict[str, dict[str, Any]]
    if args.name:
        if args.name not in servers:
            raise RuntimeError(f"mcpServers entry not found: {args.name}")
        selected = {args.name: servers[args.name]}
    else:
        selected = {str(k): v for k, v in servers.items()}

    processes: dict[str, asyncio.subprocess.Process] = {}
    capability_map: dict[str, str] = {}
    for name, server_cfg in selected.items():
        if not isinstance(server_cfg, dict):
            raise RuntimeError(f"mcpServers.{name} must be an object")
        process = await _spawn_server(name, server_cfg)
        processes[name] = process
        capability, endpoint = _derive_endpoint(name, server_cfg)
        if endpoint:
            capability_map[capability] = endpoint

    print("bridge servers started")
    if capability_map:
        print("resolved local capability endpoints:")
        print(json.dumps(capability_map, indent=2))
    else:
        print("no HTTP endpoints derived. set mcpServers.<name>.url or .port in config for local-agent routing.")

    stop_event = asyncio.Event()
    loop = asyncio.get_running_loop()

    def _signal_handler() -> None:
        stop_event.set()

    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, _signal_handler)
        except NotImplementedError:
            signal.signal(sig, lambda *_: _signal_handler())

    async def _watch(name: str, process: asyncio.subprocess.Process) -> None:
        code = await process.wait()
        print(f"[{name}] exited with code {code}")
        stop_event.set()

    watch_tasks = [asyncio.create_task(_watch(name, proc)) for name, proc in processes.items()]
    await stop_event.wait()

    for proc in processes.values():
        if proc.returncode is None:
            proc.terminate()
    await asyncio.gather(*(proc.wait() for proc in processes.values()), return_exceptions=True)
    for task in watch_tasks:
        task.cancel()


def cli() -> None:
    parser = argparse.ArgumentParser(prog="mcpassistant-gateway-bridge", description="Run MCP servers from mcpServers config")
    parser.add_argument("--config", default="config.json", help="Path to config JSON containing mcpServers")
    parser.add_argument("--name", default="", help="Run only one mcpServers entry by name")
    parsed = parser.parse_args()
    asyncio.run(_run(parsed))


if __name__ == "__main__":
    cli()

