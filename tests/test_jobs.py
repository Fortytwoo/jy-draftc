from __future__ import annotations

import concurrent.futures
import sys
import time

from filelock import FileLock

from jy_edit_mcp.core import read_json, uid, write_json
from jy_edit_mcp.jobs import Jobs
from jy_edit_mcp.worker import execute


def make_job(editor, timeout=30):
    job_id = uid()
    directory = editor.root / "jobs" / job_id
    write_json(
        directory / "job.json",
        {
            "job_id": job_id,
            "status": "queued",
            "stage": "queued",
            "pid": None,
            "command": [sys.executable, "-c", "import time; time.sleep(60)"],
            "timeout": timeout,
        },
    )
    return job_id, directory


def test_running_export_cancellation_and_no_partial_publication(editor):
    job_id, directory = make_job(editor)
    with concurrent.futures.ThreadPoolExecutor() as pool:
        future = pool.submit(execute, directory)
        deadline = time.monotonic() + 5
        while read_json(directory / "job.json")["status"] != "running":
            assert time.monotonic() < deadline
            time.sleep(0.05)
        Jobs(editor).cancel(job_id)
        future.result(timeout=10)
    assert Jobs(editor).get(job_id)["status"] == "cancelled"
    assert not (directory / "output.mp4").exists()
    assert not (directory / "pending.mp4").exists()


def test_cancel_while_waiting_for_native_slot(editor):
    job_id, directory = make_job(editor)
    with (
        FileLock(str(directory.parent / "native-render.lock")),
        concurrent.futures.ThreadPoolExecutor() as pool,
    ):
        future = pool.submit(execute, directory)
        time.sleep(0.1)
        assert Jobs(editor).get(job_id)["status"] == "queued"
        Jobs(editor).cancel(job_id)
        future.result(timeout=5)
    assert Jobs(editor).get(job_id)["status"] == "cancelled"
    assert not (directory / "render.log").exists()


def test_native_timeout_is_terminal_and_releases_slot(editor):
    job_id, directory = make_job(editor, timeout=0)
    execute(directory)
    result = Jobs(editor).get(job_id)
    assert result["status"] == "failed"
    assert result["error"]["code"] == "EXPORT_TIMEOUT"
    with FileLock(str(directory.parent / "native-render.lock"), timeout=0.5):
        pass


def test_dead_worker_not_reported_as_running(editor):
    job_id, directory = make_job(editor)
    job = read_json(directory / "job.json")
    job["pid"] = 2_000_000_000
    write_json(directory / "job.json", job)
    result = Jobs(editor).get(job_id)
    assert result["status"] == "interrupted" and result["error"]["code"] == "WORKER_INTERRUPTED"
