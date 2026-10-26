"""Run the installed SDK on an owned socket and exit when Harness closes stdin."""

from __future__ import annotations

import asyncio
import json
import socket
import sys
import threading

import uvicorn
from douyin_creator_mcp.oauth_server import create_oauth_mcp


async def main() -> None:
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.bind(("127.0.0.1", 0))
    listener.listen(128)
    port = listener.getsockname()[1]
    base_url = f"http://127.0.0.1:{port}"
    mcp, _provider = create_oauth_mcp(base_url=base_url)
    server = uvicorn.Server(uvicorn.Config(
        mcp.http_app(), host="127.0.0.1", port=port, lifespan="on",
        access_log=False, log_level="warning", timeout_graceful_shutdown=3,
    ))

    def watch_parent() -> None:
        sys.stdin.buffer.read()
        server.should_exit = True

    threading.Thread(target=watch_parent, daemon=True).start()
    serving = asyncio.create_task(server.serve(sockets=[listener]))
    try:
        while not server.started and not serving.done() and not server.should_exit:
            await asyncio.sleep(0.02)
        if server.started and not server.should_exit:
            print(json.dumps({"kind": "yoyoking.douyin.ready", "url": f"{base_url}/mcp"}), flush=True)
        await serving
    finally:
        listener.close()


if __name__ == "__main__":
    asyncio.run(main())
