from __future__ import annotations

import array
import asyncio
import json
import os
import shutil
import subprocess
import time
from pathlib import Path

import pytest
from test_protocol import call, client, compose

from jy_edit_mcp.core import Settings, digest, uid


@pytest.mark.skipif(
    os.environ.get("JY_EDIT_TEST_NATIVE") != "1", reason="Opt in to local native engine acceptance"
)
async def test_real_mcp_native_export(media):
    settings = Settings.from_env()
    assert settings.native_exe and settings.jy_dir
    root = Path("build") / ("mcp-acceptance-" + uid()[:12])
    root.mkdir()
    root = root.resolve()
    inputs = root / "input"
    shutil.copytree(media, inputs)
    source = inputs / "素材 red blue.mp4"
    source_hash = digest(source)
    async with client(inputs, root / "workspace", settings.native_exe, settings.jy_dir) as session:
        caps = await call(session, "get_capabilities", check_native=True)
        assert caps["native"]["self_check_passed"]
        pid, _, _ = await compose(session)
        saved = await call(session, "save_draft", project_id=pid)
        job = await call(session, "export_video", draft_id=saved["draft_id"], timeout=120)
        job_id = job["job_id"]
        deadline = time.monotonic() + 150
        while True:
            job = await call(session, "get_job", job_id=job_id)
            if job["status"] not in {"queued", "running"}:
                break
            assert time.monotonic() < deadline, job
            await asyncio.sleep(1)
        (root / "job-result.json").write_text(json.dumps(job, ensure_ascii=False, indent=2), encoding="utf-8")
        assert job["status"] == "succeeded", job
        result = await call(session, "validate_output", job_id=job_id)
        assert result["passed"] and result["decoded"]
        assert result["media"]["duration_us"] == pytest.approx(3_000_000, abs=100_000)
        assert (result["media"]["width"], result["media"]["height"]) == (320, 180)
        assert result["media"]["has_audio"]
        output = Path(job["artifacts"][0]["path"])
        # Verify the source trim/split/speed actually changed the rendered picture: red, then blue.
        from PIL import Image

        for timestamp, channel in [(0.2, 0), (2.5, 2), (0.75, 1)]:
            frame = root / f"frame-{timestamp}.png"
            await asyncio.to_thread(
                subprocess.run,
                [
                    settings.ffmpeg,
                    "-v",
                    "error",
                    "-ss",
                    str(timestamp),
                    "-i",
                    str(output),
                    "-frames:v",
                    "1",
                    str(frame),
                ],
                check=True,
                capture_output=True,
            )
            pixel = Image.open(frame).convert("RGB").getpixel((264, 40) if channel == 1 else (40, 80))
            assert pixel[channel] > 150 and pixel[(channel + 2) % 3] < 100, pixel
        audio = await asyncio.to_thread(
            subprocess.run,
            [
                settings.ffmpeg,
                "-v",
                "error",
                "-i",
                str(output),
                "-vn",
                "-ac",
                "1",
                "-ar",
                "8000",
                "-f",
                "f32le",
                "pipe:1",
            ],
            check=True,
            capture_output=True,
        )
        samples = array.array("f", audio.stdout)

        def rms(start, end):
            values = samples[int(start * 8000) : int(end * 8000)]
            return (sum(v * v for v in values) / len(values)) ** 0.5

        body_rms, head_rms = rms(1, 1.5), rms(0, 0.05)
        assert 0.001 < body_rms < 0.05
        assert head_rms < body_rms * 0.8
        assert digest(source) == source_hash
        (root / "acceptance.json").write_text(
            json.dumps(
                {
                    "project_id": pid,
                    "draft_id": saved["draft_id"],
                    "job_id": job_id,
                    "validation": result,
                    "source_unchanged": True,
                    "mcp_restart_during_export": False,
                    "opened_in_jianying_ui": False,
                    "audio_body_rms": body_rms,
                    "audio_fade_in_rms": head_rms,
                },
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )
        print("NATIVE_ACCEPTANCE", root)
