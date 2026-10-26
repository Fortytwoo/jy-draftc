"""Export the SDK's public schemas in memory, without login or business requests.

Run with the separately installed DouyinCreatorSDK Python environment.
"""

from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path

from douyin_creator_mcp.server import VERSION, create_mcp
from fastmcp import Client


async def export() -> dict:
    async with Client(create_mcp()) as client:
        tools = await client.list_tools()
    return {
        "backend": "douyin-creator-mcp",
        "version": VERSION,
        "tools": [tool.model_dump(mode="json", exclude_none=True) for tool in tools],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    content = json.dumps(asyncio.run(export()), ensure_ascii=False, indent=2) + "\n"
    if args.check:
        if args.output.read_text(encoding="utf-8") != content:
            raise SystemExit("Douyin tool schema drift; regenerate from the installed SDK")
    else:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(content, encoding="utf-8")
    print("Douyin public tool schemas verified" if args.check else "Douyin public tool schemas exported")


if __name__ == "__main__":
    main()
