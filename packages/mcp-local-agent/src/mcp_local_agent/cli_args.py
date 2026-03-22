from __future__ import annotations

import argparse
import os
import sys
from typing import Any


def parse_cli_args(argv: list[str] | None = None) -> argparse.Namespace:
    raw_argv = list(argv) if argv is not None else sys.argv[1:]
    parser = argparse.ArgumentParser(prog="mcpassistant-gateway", description="Run and manage the local MCP bridge agent")
    subparsers = parser.add_subparsers(dest="command")

    run_parser = subparsers.add_parser("run", help="Run the local MCP bridge agent")
    run_parser.set_defaults(command="run")
    run_parser.add_argument("--config", default="", help="Path to mcp.json")
    run_parser.add_argument("--subject", default="", help="Override subject for this run")
    run_parser.add_argument("--jwt-token", default="", help="Override AGENT_JWT for this run")
    run_parser.add_argument("--remote-server-base-url", default="", help="Override remote server base URL")
    run_parser.add_argument("--websocket-url", default="", help="Override remote websocket URL")
    run_parser.add_argument("--request-timeout-seconds", type=float, default=None, help="Override local request timeout")

    config_parser = subparsers.add_parser("config", help="Inspect the resolved mcp.json path or runtime state")
    config_subparsers = config_parser.add_subparsers(dest="config_command", required=True)

    config_path_parser = config_subparsers.add_parser("path", help="Print the resolved config path")
    config_path_parser.add_argument("--config", default="", help="Path to mcp.json")

    config_show_parser = config_subparsers.add_parser("show", help="Print the current runtime state file")
    config_show_parser.add_argument("--config", default="", help="Path to mcp.json")

    config_init_parser = config_subparsers.add_parser("init", help="Create mcp.json if it does not exist")
    config_init_parser.add_argument("--config", default="", help="Path to mcp.json")

    config_set_parser = config_subparsers.add_parser("set", help="Update runtime state settings")
    config_set_parser.add_argument("--config", default="", help="Path to mcp.json")
    config_set_parser.add_argument("--subject", default="", help="Persist subject")
    config_set_parser.add_argument("--jwt-token", default="", help="Persist JWT token")
    config_set_parser.add_argument("--remote-server-base-url", default="", help="Persist remote server base URL")
    config_set_parser.add_argument("--websocket-url", default="", help="Persist websocket URL")
    config_set_parser.add_argument("--request-timeout-seconds", type=float, default=None, help="Persist local request timeout")

    settings_parser = subparsers.add_parser("settings", help="Interactive settings editor")
    settings_parser.add_argument("--config", default="", help="Path to mcp.json")

    menu_parser = subparsers.add_parser("menu", help="Open an interactive CLI menu")
    menu_parser.add_argument("--config", default="", help="Path to mcp.json")

    args = parser.parse_args(raw_argv)
    if args.command is None:
        if raw_argv and raw_argv[0].startswith("-"):
            args = parser.parse_args(["run", *raw_argv])
        else:
            args = parser.parse_args(["menu", *raw_argv])
    return args


def apply_cli_overrides(args: argparse.Namespace) -> None:
    if getattr(args, "config", ""):
        os.environ["AGENT_CONFIG_PATH"] = args.config
    if getattr(args, "subject", ""):
        os.environ["SUBJECT"] = args.subject
    if getattr(args, "jwt_token", ""):
        os.environ["AGENT_JWT"] = args.jwt_token
    if getattr(args, "remote_server_base_url", ""):
        os.environ["REMOTE_SERVER_BASE_URL"] = args.remote_server_base_url
    if getattr(args, "websocket_url", ""):
        os.environ["REMOTE_WEBSOCKET_URL"] = args.websocket_url
    if getattr(args, "request_timeout_seconds", None) is not None:
        os.environ["REQUEST_TIMEOUT_SECONDS"] = str(args.request_timeout_seconds)


def config_updates_from_args(args: argparse.Namespace) -> dict[str, Any]:
    updates: dict[str, Any] = {}
    if getattr(args, "subject", ""):
        updates["subject"] = args.subject
    if getattr(args, "jwt_token", ""):
        updates["jwt_token"] = args.jwt_token
    if getattr(args, "remote_server_base_url", ""):
        updates["remote_server_base_url"] = args.remote_server_base_url
    if getattr(args, "websocket_url", ""):
        updates["websocket_url"] = args.websocket_url
    if getattr(args, "request_timeout_seconds", None) is not None:
        updates["request_timeout_seconds"] = max(1.0, float(args.request_timeout_seconds))
    return updates
