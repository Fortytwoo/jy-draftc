"""Opt-in vendor CLI acceptance using only newly generated native projects."""

from __future__ import annotations

import os
import shutil
from dataclasses import replace
from pathlib import Path

import pytest
from test_protocol import call, client

from jy_edit_mcp.core import Settings, digest, uid, write_json
from jy_edit_mcp.editor import Editor
from jy_edit_mcp.native_drafts import NativeDrafts, draft_root


@pytest.mark.skipif(
    os.environ.get("JY_EDIT_TEST_NATIVE_EDITS") != "1",
    reason="Opt in to creating new synthetic native project copies; never edit existing projects",
)
async def test_real_native_edit_copies(media):
    root = Path("build") / ("native-edits-acceptance-" + uid()[:12])
    root.mkdir()
    root = root.resolve()
    inputs = root / "input"
    shutil.copytree(media, inputs)
    settings = replace(Settings.from_env(), workspace=root / "workspace", media_roots=(inputs,))
    editor = Editor(settings)
    adapter = NativeDrafts(editor)
    name = "mcp-native-acceptance-" + uid()
    ref = "local://" + name
    adapter.cli(["draft", "project", "create", "--ref", ref])
    adapter.cli(
        [
            "draft",
            "video",
            "add",
            "--ref",
            ref,
            "--resource",
            "local:///" + (inputs / "素材 red blue.mp4").as_posix(),
            "--start",
            "0s",
            "--duration",
            "2s",
            "--track",
            "0",
        ]
    )
    for start in [0, 2, 4]:
        adapter.cli(
            [
                "draft",
                "video",
                "add",
                "--ref",
                ref,
                "--resource",
                "local:///" + (inputs / "素材 red blue.mp4").as_posix(),
                "--start",
                f"{start}s",
                "--duration",
                "2s",
                "--track",
                "1",
            ]
        )
    adapter.cli(
        [
            "draft",
            "subtitle",
            "add",
            "--ref",
            ref,
            "--content",
            "Unlinked caption",
            "--start",
            "5s",
            "--duration",
            "0.5s",
        ]
    )
    clips = [
        segment["id"]
        for track in adapter.read(ref)["content"]["tracks"]
        if track["type"] == "video" and track.get("flag", 0) & 2
        for segment in track["segments"]
    ]
    source = draft_root(settings) / name
    source_hashes = {p.relative_to(source).as_posix(): digest(p) for p in source.rglob("*") if p.is_file()}
    receipt = {"source_ref": ref, "source_path": str(source), "results": {}, "ui_opened": False}
    write_json(root / "acceptance.json", receipt)
    try:
        async with client(inputs, settings.workspace, settings.native_exe, settings.jy_dir) as session:
            original = await call(session, "get_native_draft", ref=ref)
            detail = await call(session, "get_native_clip", ref=ref, seg_id=clips[2])
            assert detail["materials"] and detail["content_sha256"] == original["content_sha256"]
            for name, tool, arguments in [
                ("ripple", "remove_native_clip", {"seg_id": clips[0], "ripple": True}),
                ("constant_speed", "set_native_clip_speed", {"seg_id": clips[2], "speed": 2}),
                ("preset_curve", "set_native_clip_speed", {"seg_id": clips[2], "curve_name": "Montage"}),
                (
                    "custom_curve",
                    "set_native_clip_speed",
                    {"seg_id": clips[2], "curve_points": [{"x": 0, "y": 1}, {"x": 1, "y": 2}]},
                ),
                (
                    "subtitles",
                    "add_native_subtitles",
                    {
                        "cues": [
                            {"start": 0, "duration": 0.8, "text": "第一句"},
                            {"start": 1, "duration": 0.8, "text": "Second line"},
                        ]
                    },
                ),
            ]:
                result = await call(
                    session, tool, ref=ref, expected_content_sha256=original["content_sha256"], **arguments
                )
                assert result["status"] == "succeeded" and result["source_preserved"]
                persisted = await call(session, "get_native_operation", operation_id=result["operation_id"])
                assert persisted["output_sha256"] == result["output_sha256"]
                receipt["results"][name] = result
                write_json(root / "acceptance.json", receipt)
            history = await call(session, "list_native_operations", limit=2)
            assert len(history["operations"]) == 2 and history["next_offset"] == 2
            receipt["stdio_verified"] = True
        assert all(digest(source / p) == value for p, value in source_hashes.items())
        receipt["source_preserved"] = True
    finally:
        write_json(root / "acceptance.json", receipt)
        print("NATIVE_EDITS_ACCEPTANCE", root)
