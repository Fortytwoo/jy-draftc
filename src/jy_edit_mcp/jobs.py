from __future__ import annotations

import os
import subprocess
import sys
import time
from fractions import Fraction

from filelock import FileLock

from .core import EditError, checked_id, digest, probe, read_json, run, uid, write_json
from .drafts import load_draft
from .editor import Editor


def validate_video(settings, path, expected: dict | None = None) -> dict:
    info = probe(settings, path, with_hash=False)
    if not info["video_codec"] or not info["duration_us"] or info["duration_us"] <= 0:
        raise EditError("OUTPUT_INVALID", "Output has no timed video stream.")
    if expected:
        tolerance = max(100_000, round(2e6 / expected["fps"]))
        if abs(info["duration_us"] - expected["duration_us"]) > tolerance:
            raise EditError(
                "OUTPUT_DURATION_MISMATCH",
                "Export duration differs from the saved timeline.",
                expected_us=expected["duration_us"],
                actual_us=info["duration_us"],
            )
        if (info["width"], info["height"]) != (expected["width"], expected["height"]):
            raise EditError("OUTPUT_SIZE_MISMATCH", "Export dimensions differ from the saved canvas.")
        if abs(float(Fraction(info["frame_rate"] or "0")) - expected["fps"]) > 0.01:
            raise EditError("OUTPUT_FPS_MISMATCH", "Export frame rate differs from the saved timeline.")
        if expected.get("codec") and info["video_codec"] != expected["codec"]:
            raise EditError("OUTPUT_CODEC_MISMATCH", "Export codec differs from the requested codec.")
        if expected.get("has_audio") and not info["has_audio"]:
            raise EditError(
                "OUTPUT_AUDIO_MISSING", "Timeline contains audible clips, but output has no audio stream."
            )
    run([settings.ffmpeg, "-v", "error", "-xerror", "-i", str(path), "-f", "null", "-"], timeout=600)
    return {"passed": True, "decoded": True, "media": info, "sha256": digest(path)}


class Jobs:
    def __init__(self, editor: Editor):
        self.editor = editor
        self.settings = editor.settings

    def directory(self, job_id):
        path = self.editor.root / "jobs" / checked_id(job_id)
        if not (path / "job.json").is_file():
            raise EditError("JOB_NOT_FOUND", "Unknown job ID.")
        return path

    def export(self, draft_id, codec="h264", bitrate="4M", timeout=900, options=None):
        settings = self.settings
        if not settings.native_exe or not settings.native_exe.is_file():
            raise EditError("NATIVE_UNAVAILABLE", "Configure JY_DRAFTC_EXE.")
        if not settings.jy_dir or not (settings.jy_dir / "videoeditor.dll").is_file():
            raise EditError("RUNTIME_UNAVAILABLE", "Configure JY_INSTALL_DIR with the matching runtime.")
        directory, manifest = load_draft(self.editor, draft_id)
        options = options.model_dump(exclude_none=True) if options else {}
        expected = {k: options.get(k, manifest[k]) for k in ["width", "height", "fps", "duration_us"]}
        job_id = uid()
        jobdir = self.editor.root / "jobs" / job_id
        jobdir.mkdir()
        pending = jobdir / "pending.mp4"
        command = [
            str(settings.native_exe),
            "-ex",
            str(directory),
            "-o",
            str(pending),
            "--jy-dir",
            str(settings.jy_dir),
            "--fps",
            str(expected["fps"]),
            "--width",
            str(expected["width"]),
            "--height",
            str(expected["height"]),
            "--codec",
            codec,
            "--bitrate",
            bitrate,
            "--timeout",
            str(timeout),
            "-j",
            "1",
            "-q",
        ]
        for key in ["hard_encode", "quality", "color_space", "mp4"]:
            if key in options:
                command += ["--" + key.replace("_", "-"), str(options[key])]
        job = {
            "job_id": job_id,
            "draft_id": draft_id,
            "project_id": manifest["project_id"],
            "revision": manifest["revision"],
            "status": "queued",
            "stage": "queued",
            "backend": "jy-draftc-native",
            "created_at": time.time(),
            "pid": None,
            "command": command,
            "timeout": timeout,
            "ffmpeg": settings.ffmpeg,
            "ffprobe": settings.ffprobe,
            "expected": expected,
            "warnings": manifest["warnings"],
            "artifacts": [],
            "error": None,
        }
        sources = {str(directory / "draft_content.json"): manifest["content_sha256"]}
        has_audio = False
        if manifest.get("mode") == "template":
            sources.update(manifest["source_hashes"])
            # Imported engine effects can generate/mute audio; do not claim inferred audio acceptance.
            job["audio_expectation"] = "not_inferred_for_external_template"
        for track in manifest.get("plan", {}).get("tracks", []):
            for clip in track["clips"]:
                asset = clip["asset"]
                if asset:
                    sources[asset["path"]] = asset["sha256"]
                    if asset["audio_path"]:
                        sources[asset["audio_path"]] = asset["audio_sha256"]
                    has_audio |= asset["has_audio"] and clip["volume"] > 0
        job["expected"].update(codec=codec, has_audio=has_audio)
        job["source_hashes"] = sources
        write_json(jobdir / "job.json", job)
        env = os.environ.copy()
        env.update(PYTHONUTF8="1", PYTHONIOENCODING="utf-8")
        try:
            with (jobdir / "worker.log").open("wb") as log:
                worker = subprocess.Popen(
                    [sys.executable, "-m", "jy_edit_mcp.worker", str(jobdir)],
                    stdin=subprocess.DEVNULL,
                    stdout=log,
                    stderr=log,
                    env=env,
                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                    start_new_session=os.name != "nt",
                )
            with FileLock(str(jobdir / "job.lock")):
                current = read_json(jobdir / "job.json")
                current["pid"] = worker.pid
                write_json(jobdir / "job.json", current)
        except OSError as exc:
            job.update(
                status="failed", stage="spawn", error={"code": "WORKER_START_FAILED", "message": str(exc)}
            )
            write_json(jobdir / "job.json", job)
            raise EditError("WORKER_START_FAILED", str(exc)) from exc
        return self.get(job_id)

    def get(self, job_id):
        directory = self.directory(job_id)
        with FileLock(str(directory / "job.lock")):
            job = read_json(directory / "job.json")
            if job["status"] in {"queued", "running"} and job.get("pid") and not process_alive(job["pid"]):
                job.update(
                    status="interrupted",
                    stage="interrupted",
                    error={
                        "code": "WORKER_INTERRUPTED",
                        "message": "Worker no longer exists; submit a new export.",
                    },
                )
                write_json(directory / "job.json", job)
        return {
            k: v
            for k, v in job.items()
            if k not in {"command", "ffmpeg", "ffprobe", "expected", "source_hashes"}
        } | {
            "log_path": str(directory / "render.log"),
            "worker_log_path": str(directory / "worker.log"),
        }

    def cancel(self, job_id):
        directory = self.directory(job_id)
        with FileLock(str(directory / "job.lock")):
            job = read_json(directory / "job.json")
            if job["status"] in {"queued", "running"}:
                (directory / "cancel").touch()
        return {**self.get(job_id), "cancellation_requested": (directory / "cancel").exists()}


def process_alive(pid: int) -> bool:
    if os.name == "nt":
        import ctypes
        from ctypes import wintypes

        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.OpenProcess.restype = wintypes.HANDLE
        kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        handle = kernel.OpenProcess(0x1000, False, pid)
        if not handle:
            return False
        try:
            code = wintypes.DWORD()
            kernel.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
            return bool(kernel.GetExitCodeProcess(handle, ctypes.byref(code))) and code.value == 259
        finally:
            kernel.CloseHandle.argtypes = [wintypes.HANDLE]
            kernel.CloseHandle(handle)
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False
