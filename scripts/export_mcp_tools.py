"""Export the actual MCP tool contracts for Skill authors; --check detects documentation drift."""

from __future__ import annotations

import argparse
import asyncio
import json
import tempfile
from dataclasses import replace
from pathlib import Path

from jy_edit_mcp import __version__
from jy_edit_mcp.core import Settings
from jy_edit_mcp.server import build_server


async def export():
    with tempfile.TemporaryDirectory(prefix="jy-edit-tool-catalog-") as temp:
        settings = replace(Settings.from_env(), workspace=Path(temp).resolve())
        tools = await build_server(settings).list_tools()
        return {
            "server": "jy-edit",
            "version": __version__,
            "time_unit": "seconds",
            "tools": [tool.model_dump(mode="json", exclude_none=True) for tool in tools],
        }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    path = Path(__file__).resolve().parent.parent / "docs/jy-edit-tools.json"
    text = json.dumps(asyncio.run(export()), ensure_ascii=False, indent=2) + "\n"
    if args.check:
        if not path.exists() or path.read_text(encoding="utf-8") != text:
            raise SystemExit("Tool catalog changed; run uv run scripts/export_mcp_tools.py")
        print("Tool catalog matches the server.")
    else:
        path.write_text(text, encoding="utf-8")
        print(f"Exported tool catalog: {path}")


if __name__ == "__main__":
    main()
