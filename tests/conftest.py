from __future__ import annotations

import shutil
import subprocess

import pytest

from jy_edit_mcp.core import Settings
from jy_edit_mcp.editor import Editor


@pytest.fixture(scope="session")
def media(tmp_path_factory):
    root = tmp_path_factory.mktemp("media_中文 空格")
    ffmpeg, ffprobe = shutil.which("ffmpeg"), shutil.which("ffprobe")
    if not ffmpeg or not ffprobe:
        pytest.skip("FFmpeg and ffprobe are required")
    video = root / "素材 red blue.mp4"
    subprocess.run(
        [
            ffmpeg,
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "color=red:s=320x180:r=30:d=3",
            "-f",
            "lavfi",
            "-i",
            "color=blue:s=320x180:r=30:d=3",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:sample_rate=48000:duration=6",
            "-filter_complex",
            "[0:v][1:v]concat=n=2:v=1:a=0[v]",
            "-map",
            "[v]",
            "-map",
            "2:a",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            str(video),
        ],
        check=True,
        capture_output=True,
    )
    subprocess.run(
        [
            ffmpeg,
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "color=lime:s=80x80",
            "-frames:v",
            "1",
            str(root / "overlay.png"),
        ],
        check=True,
        capture_output=True,
    )
    (root / "captions.srt").write_text(
        "1\n00:00:00,000 --> 00:00:00,900\n第一句\n\n2\n00:00:01,000 --> 00:00:01,900\nSecond line\n",
        encoding="utf-8",
    )
    return root


@pytest.fixture
def editor(tmp_path, media):
    return Editor(Settings(tmp_path / "workspace", (media,), shutil.which("ffmpeg"), shutil.which("ffprobe")))


@pytest.fixture
def timeline(editor):
    project_id = editor.create("测试工程", 320, 180)["project_id"]
    track_id = editor.add_track(project_id, "video", "主轨")["track_id"]
    clip_id = editor.add_media(project_id, track_id, "video", "素材 red blue.mp4", 0)["clip_id"]
    return project_id, track_id, clip_id
