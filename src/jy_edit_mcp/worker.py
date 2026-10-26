"""One persisted native export job; MCP hosts can still bound its process lifetime."""

from __future__ import annotations

import os
import signal
import subprocess
import sys
import time
from pathlib import Path

from filelock import FileLock, Timeout

from .core import EditError, Settings, digest, read_json, write_json
from .jobs import validate_video


def terminate(process):
    if process.poll() is not None:
        return
    if os.name == "nt":
        subprocess.run(
            ["taskkill", "/PID", str(process.pid), "/T", "/F"],
            check=False,
            capture_output=True,
            creationflags=subprocess.CREATE_NO_WINDOW,
        )
    else:
        os.killpg(process.pid, signal.SIGKILL)
    process.wait(timeout=15)


def execute(directory: Path):
    path = directory / "job.json"
    lock = FileLock(str(directory / "job.lock"))

    def update(**changes):
        with lock:
            current = read_json(path)
            current.update(changes)
            write_json(path, current)
            return current

    job = read_json(path)
    slot = FileLock(str(directory.parent / "native-render.lock"))
    queue_deadline = time.monotonic() + job["timeout"]
    while True:
        if (directory / "cancel").exists():
            update(status="cancelled", stage="cancelled", finished_at=time.time())
            return
        try:
            slot.acquire(timeout=0.2)
            break
        except Timeout:
            if time.monotonic() > queue_deadline:
                update(
                    status="failed",
                    stage="queue",
                    finished_at=time.time(),
                    error={
                        "code": "QUEUE_TIMEOUT",
                        "message": "No native render slot before queue deadline.",
                    },
                )
                return
    job = update(status="running", stage="render", started_at=time.time())
    process = None
    try:
        with (directory / "render.log").open("wb") as log:
            process = subprocess.Popen(
                job["command"],
                stdin=subprocess.DEVNULL,
                stdout=log,
                stderr=log,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                start_new_session=os.name != "nt",
            )
            deadline = time.monotonic() + job["timeout"] + 5
            while process.poll() is None:
                if (directory / "cancel").exists():
                    terminate(process)
                    update(status="cancelled", stage="cancelled", finished_at=time.time())
                    return
                if time.monotonic() > deadline:
                    terminate(process)
                    raise EditError("EXPORT_TIMEOUT", "Native export exceeded its deadline.")
                time.sleep(0.2)
        if process.returncode:
            raise EditError(
                "NATIVE_EXPORT_FAILED", "See render.log for the native error.", exit_code=process.returncode
            )
        update(stage="validate")
        pending = directory / "pending.mp4"
        if not pending.is_file():
            raise EditError("OUTPUT_MISSING", "Native process returned success without output.")
        settings = Settings(directory, (directory,), job["ffmpeg"], job["ffprobe"])
        result = validate_video(settings, pending, job["expected"])
        for source, sha256 in job.get("source_hashes", {}).items():
            if digest(Path(source)) != sha256:
                raise EditError(
                    "SOURCE_CHANGED_DURING_EXPORT", "A draft or media source changed while rendering."
                )
        with lock:
            current = read_json(path)
            if (directory / "cancel").exists():
                current.update(status="cancelled", stage="cancelled", finished_at=time.time())
            else:
                final = directory / "output.mp4"
                os.rename(pending, final)
                result["media"]["path"] = str(final)
                current.update(
                    status="succeeded",
                    stage="complete",
                    finished_at=time.time(),
                    artifacts=[{"kind": "video", "path": str(final), "sha256": result["sha256"]}],
                    validation=result,
                )
            write_json(path, current)
    except Exception as exc:  # noqa: BLE001 -- persist every worker failure as a terminal job receipt.
        if process and process.poll() is None:
            terminate(process)
        error = {
            "code": exc.code if isinstance(exc, EditError) else "EXPORT_FAILED",
            "message": str(exc),
            **(exc.details if isinstance(exc, EditError) else {}),
        }
        update(status="failed", stage="failed", error=error, finished_at=time.time())
    finally:
        (directory / "pending.mp4").unlink(missing_ok=True)
        slot.release()


if __name__ == "__main__":
    execute(Path(sys.argv[1]).resolve())
