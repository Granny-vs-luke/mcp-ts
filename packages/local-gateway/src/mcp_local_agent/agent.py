from __future__ import annotations

from .bridge_runtime import LocalBridgeAgent
from .cli_app import cli

__all__ = ["LocalBridgeAgent", "cli"]


if __name__ == "__main__":
    cli()
