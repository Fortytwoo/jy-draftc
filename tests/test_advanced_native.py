"""Opt-in, genuine engine export and conversion; uses only newly generated media."""

import asyncio
import json
import os
import shutil
import time
from pathlib import Path

import pytest
from test_protocol import call, client

from jy_edit_mcp.core import Settings, digest, uid

pytestmark = pytest.mark.skipif(
    os.environ.get("JY_EDIT_TEST_NATIVE") != "1", reason="Opt in to native acceptance"
)


async def finish(session, job):
    deadline = time.monotonic() + 150
    while job["status"] in {"queued", "running"}:
        assert time.monotonic() < deadline, job
        await asyncio.sleep(0.5)
        job = await call(session, "get_job", job_id=job["job_id"])
    return job


async def test_advanced_export_template_and_native_crypto_version_roundtrip(media):
    settings = Settings.from_env()
    root = (Path("build") / ("advanced-acceptance-" + uid()[:12])).resolve()
    inputs = root / "input"
    shutil.copytree(media, inputs)
    source = inputs / "素材 red blue.mp4"
    source_hash = digest(source)
    report = {"root": str(root), "source_unchanged": False, "opened_in_jianying_ui": False}
    async with client(inputs, root / "workspace", settings.native_exe, settings.jy_dir) as session:
        pid = (await call(session, "create_project", name="Advanced native", width=320, height=180))[
            "project_id"
        ]
        track = (await call(session, "add_track", project_id=pid, kind="video", name="Video"))["track_id"]
        video = (
            await call(
                session, "add_video_clip", project_id=pid, track_id=track, path=str(source), source_duration=2
            )
        )["clip_id"]
        await call(session, "set_clip_crop", project_id=pid, clip_id=video, crop={"left": 0.1, "right": 0.9})
        await call(
            session, "set_clip_audio", project_id=pid, clip_id=video, volume=0.2, fade_in=0.2, fade_out=0.2
        )
        await call(
            session,
            "set_clip_background",
            project_id=pid,
            clip_id=video,
            background={"fill_type": "color", "color": "#0000FFFF"},
        )
        text_track = (await call(session, "add_track", project_id=pid, kind="text", name="Text"))["track_id"]
        text = (
            await call(
                session,
                "add_text_clip",
                project_id=pid,
                track_id=text_track,
                text="Advanced text",
                duration=1,
            )
        )["clip_id"]
        await call(
            session,
            "set_text_style",
            project_id=pid,
            clip_id=text,
            style={"size": 6, "underline": True, "letter_spacing": 1},
        )
        await call(
            session,
            "set_text_background",
            project_id=pid,
            clip_id=text,
            background={"color": "#00FF00", "round_radius": 0.2},
        )
        await call(session, "set_text_shadow", project_id=pid, clip_id=text, shadow={"distance": 8})
        saved = await call(session, "save_draft", project_id=pid)
        report["draft_id"] = saved["draft_id"]
        plain = saved["content_path"]
        original_hash = digest(Path(plain))
        converted = {}
        for operation, path, extra in [
            ("encrypt", plain, {}),
            ("decrypt", None, {}),
            ("upgrade", plain, {"target_version": "189.0.0"}),
            ("downgrade", None, {"target_version": "179.0.0"}),
        ]:
            if operation == "decrypt":
                path = converted["encrypt"]["artifacts"][0]
            if operation == "downgrade":
                path = converted["upgrade"]["artifacts"][0]
            converted[operation] = await call(
                session, "convert_local_draft", path=path, operation=operation, **extra
            )
        decoded = Path(converted["decrypt"]["artifacts"][0])
        assert json.loads(decoded.read_text(encoding="utf-8"))["tracks"]
        assert digest(Path(plain)) == original_hash
        report["conversions"] = converted
        report["native_check"] = await call(session, "check_local_draft", path=plain)
        job = await call(
            session,
            "export_local_draft",
            path=plain,
            timeout=120,
            options={
                "width": 160,
                "height": 90,
                "fps": 25,
                "hard_encode": 0,
                "quality": 0,
                "color_space": 0,
                "mp4": 0,
            },
        )
        job = await finish(session, job)
        report["export"] = job
        (root / "acceptance.json").write_text(
            json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        assert job["status"] == "succeeded", job
        result = await call(session, "validate_output", job_id=job["job_id"])
        assert (result["media"]["width"], result["media"]["height"]) == (160, 90)
        assert result["media"]["has_audio"]
        assert result["media"]["frame_rate"] == "25/1"
        report["source_unchanged"] = digest(source) == source_hash
        assert report["source_unchanged"]
        report["validation"] = result
        (root / "acceptance.json").write_text(
            json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
        )
    print("ADVANCED_NATIVE_ACCEPTANCE", root)
