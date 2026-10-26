from __future__ import annotations

import json
import os
import sys
from contextlib import asynccontextmanager
from pathlib import Path

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client


@asynccontextmanager
async def client(media: Path, workspace: Path, native=None, jy_dir=None):
    env = {
        **os.environ,
        "JY_EDIT_MEDIA_ROOTS": json.dumps([str(media)]),
        "JY_EDIT_WORKSPACE": str(workspace),
        "PYTHONUTF8": "1",
        "PYTHONIOENCODING": "utf-8",
    }
    if native:
        env["JY_DRAFTC_EXE"] = str(native)
    if jy_dir:
        env["JY_INSTALL_DIR"] = str(jy_dir)
    params = StdioServerParameters(command=sys.executable, args=["-m", "jy_edit_mcp.server"], env=env)
    async with stdio_client(params) as streams, ClientSession(*streams) as session:
        await session.initialize()
        yield session


async def call(session, tool_name, **kwargs):
    result = await session.call_tool(tool_name, kwargs)
    assert not result.isError, (tool_name, result)
    assert result.structuredContent and result.structuredContent["ok"], (tool_name, result)
    return result.structuredContent


async def compose(session):
    project = await call(session, "create_project", name="MCP组合剪辑", width=320, height=180)
    pid = project["project_id"]
    tracks = {}
    for kind, name in [
        ("video", "主轨"),
        ("audio", "背景音"),
        ("video", "画中画"),
        ("text", "标题"),
        ("text", "字幕"),
    ]:
        tracks[name] = (await call(session, "add_track", project_id=pid, kind=kind, name=name))["track_id"]
    added = await call(
        session, "add_video_clip", project_id=pid, track_id=tracks["主轨"], path="素材 red blue.mp4"
    )
    clip = added["clip_id"]
    await call(session, "trim_clip", project_id=pid, clip_id=clip, source_in=0, source_out=6)
    split = await call(session, "split_clip", project_id=pid, clip_id=clip, at=3)
    right = split["right_clip_id"]
    await call(session, "trim_clip", project_id=pid, clip_id=clip, source_in=1, source_out=3)
    await call(session, "move_clip", project_id=pid, clip_id=right, start=2)
    await call(session, "set_clip_speed", project_id=pid, clip_id=right, speed=3)
    for cid in [clip, right]:
        await call(session, "set_clip_audio", project_id=pid, clip_id=cid, volume=0)
    await call(session, "set_clip_transform", project_id=pid, clip_id=right, transform={"fit": "cover"})
    await call(
        session,
        "set_keyframes",
        project_id=pid,
        clip_id=right,
        property_name="scale_x",
        points=[{"time": 0, "value": 1}, {"time": 1, "value": 1.1}],
    )
    audio = (
        await call(
            session,
            "add_audio_clip",
            project_id=pid,
            track_id=tracks["背景音"],
            path="素材 red blue.mp4",
            source_duration=3,
        )
    )["clip_id"]
    await call(
        session, "set_clip_audio", project_id=pid, clip_id=audio, volume=0.25, fade_in=0.2, fade_out=0.2
    )
    overlay = (
        await call(
            session,
            "add_image_clip",
            project_id=pid,
            track_id=tracks["画中画"],
            path="overlay.png",
            start=0.5,
            duration=0.5,
        )
    )["clip_id"]
    await call(
        session,
        "set_clip_transform",
        project_id=pid,
        clip_id=overlay,
        transform={"x": 0.65, "y": 0.55, "scale_x": 0.25, "scale_y": 0.25},
    )
    text = (
        await call(
            session, "add_text_clip", project_id=pid, track_id=tracks["标题"], text="MCP test", duration=2
        )
    )["clip_id"]
    await call(session, "set_clip_duration", project_id=pid, clip_id=text, duration=3)
    await call(
        session,
        "set_text_style",
        project_id=pid,
        clip_id=text,
        style={"size": 7, "bold": True, "border_width": 20},
    )
    await call(session, "set_clip_transform", project_id=pid, clip_id=text, transform={"y": 0.7})
    await call(session, "import_subtitles", project_id=pid, track_id=tracks["字幕"], path="captions.srt")
    await call(session, "reorder_track", project_id=pid, track_id=tracks["字幕"], index=4)
    scratch = (
        await call(
            session,
            "add_text_clip",
            project_id=pid,
            track_id=tracks["标题"],
            text="remove me",
            start=4,
            duration=1,
        )
    )["clip_id"]
    await call(session, "remove_clip", project_id=pid, clip_id=scratch, ripple=True)
    return pid, clip, right


async def test_stdio_composition_schema_and_persistence(media, tmp_path):
    workspace = tmp_path / "protocol"
    async with client(media, workspace) as session:
        tools = (await session.list_tools()).tools
        assert len(tools) == 71
        assert {
            "list_native_projects",
            "get_native_draft",
            "split_native_clip",
            "prepare_native_copy",
            "get_native_clip",
            "list_native_operations",
            "get_native_operation",
            "remove_native_clip",
            "set_native_clip_speed",
            "add_native_subtitles",
        } <= {tool.name for tool in tools}
        assert all(t.inputSchema["type"] == "object" and t.annotations for t in tools)
        assert (
            "transform" in next(t for t in tools if t.name == "set_clip_transform").inputSchema["properties"]
        )
        await call(session, "probe_media", path="素材 red blue.mp4")
        frame = await session.call_tool("extract_frame", {"path": "素材 red blue.mp4", "at": 4})
        assert not frame.isError and any(
            c.type == "image" and c.mimeType == "image/png" for c in frame.content
        )
        pid, left, right = await compose(session)
        before = await call(session, "get_project", project_id=pid, limit=1)
        assert before["next_offset"] == 1 and before["duration"] == 3
        bad = await session.call_tool("set_clip_speed", {"project_id": pid, "clip_id": right, "speed": -1})
        assert bad.isError
        after = await call(session, "get_project", project_id=pid)
        assert before["revision"] == after["revision"]
        conflict = await session.call_tool(
            "move_clip", {"project_id": pid, "clip_id": right, "start": 2, "expected_revision": 0}
        )
        assert conflict.isError and conflict.structuredContent["error"]["code"] == "REVISION_CONFLICT"
        transitions = await call(session, "list_transitions", query="叠化")
        assert any(t["name"] == "叠化" for t in transitions["transitions"])
        await call(session, "set_transition", project_id=pid, clip_id=left, name="叠化", duration=0.3)
        saved = await call(session, "save_draft", project_id=pid)
        assert saved["warnings"] and saved["validation"]["generated"]
        content = json.loads(Path(saved["content_path"]).read_text(encoding="utf-8"))
        assert content["materials"]["transitions"]
    async with client(media, workspace) as session:
        listed = await call(session, "list_projects")
        assert listed["projects"][0]["project_id"] == pid
        loaded = await call(session, "get_project", project_id=pid)
        assert loaded["duration"] == 3 and loaded["clip_count"] == 7
