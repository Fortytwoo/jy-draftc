"""Opt-in real stdio acceptance: split a new native copy and preserve the user project."""

import asyncio
import json
import os
import sys
from pathlib import Path

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

from jy_edit_mcp.core import uid, write_json


async def main():
    root = Path("build/native-split-acceptance-" + uid()[:12]).resolve()
    root.mkdir(parents=True)
    env = {
        **os.environ,
        "JY_EDIT_WORKSPACE": str(root / "workspace"),
        "JY_EDIT_MEDIA_ROOTS": json.dumps([str(Path.cwd())]),
        "PYTHONUTF8": "1",
        "PYTHONIOENCODING": "utf-8",
    }
    params = StdioServerParameters(command=sys.executable, args=["-m", "jy_edit_mcp.server"], env=env)
    async with stdio_client(params) as streams, ClientSession(*streams) as session:
        await session.initialize()

        async def call(name, **args):
            result = await session.call_tool(name, args)
            write_json(root / (name + ".json"), result.model_dump(mode="json", exclude_none=True))
            assert not result.isError, result
            assert result.structuredContent["ok"], result
            return result.structuredContent

        schema = await session.list_tools()
        assert {"list_native_projects", "get_native_draft", "split_native_clip"} <= {
            tool.name for tool in schema.tools
        }
        await call("list_native_projects")
        ref = "local://数策嵌入POC"
        before = await call("get_native_draft", ref=ref)
        segment = next(item for item in before["segments"] if item["track_type"] == "video")
        result = await call(
            "split_native_clip",
            ref=ref,
            seg_id=segment["segment_id"],
            points=[60],
            expected_content_sha256=before["content_sha256"],
        )
        after = await call("get_native_draft", ref=result["output_ref"])
        source_after = await call("get_native_draft", ref=ref)
        assert before["content_sha256"] == source_after["content_sha256"]
        assert after["segment_count"] == before["segment_count"] + 1
        write_json(
            root / "acceptance.json",
            {
                "passed": True,
                "source_preserved": True,
                "output_ref": result["output_ref"],
                "output_path": result["output_path"],
                "catalog_updated": result["desktop_catalog_updated"],
                "warnings": result["warnings"],
                "ui_opened": False,
                "segments": result["segments"],
            },
        )
        print(
            json.dumps(
                {
                    "passed": True,
                    "directory": str(root),
                    "output_ref": result["output_ref"],
                    "segments": result["segments"],
                    "catalog_updated": result["desktop_catalog_updated"],
                },
                ensure_ascii=False,
            )
        )


if __name__ == "__main__":
    asyncio.run(main())
