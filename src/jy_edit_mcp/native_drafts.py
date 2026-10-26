"""Vendor-native, copy-on-write draft editing. Never patch the user's source project."""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import subprocess
import tempfile
from copy import deepcopy
from pathlib import Path

from filelock import FileLock

from .core import EditError, checked_id, digest, read_json, run, uid, us, write_json
from .template_tools import native

RUNNER = """const {spawnSync}=require("child_process");
const {join,dirname}=require("path");
const result=spawnSync(join(dirname(process.execPath),"lyra-cli.exe"),process.argv.slice(2),{
cwd:process.cwd(),env:process.env,encoding:"utf8",windowsHide:true,timeout:45000,maxBuffer:8388608});
if(result.stdout)process.stdout.write(result.stdout);
if(result.stderr)process.stderr.write(result.stderr);
if(result.error)process.exit(124);
process.exit(result.status===null?1:result.status);
"""


def project_name(ref: str) -> str:
    if not isinstance(ref, str) or not ref.startswith("local://"):
        raise EditError("INVALID_NATIVE_REF", "Use an exact local://name returned by list_native_projects.")
    name = ref[8:]
    if not name or name in {".", ".."} or any(c in name for c in '/\\\0<>:"|?*') or name[-1] in ". ":
        raise EditError("INVALID_NATIVE_REF", "Native references must identify one project name, not a path.")
    return name


def draft_root(settings) -> Path:
    if settings.native_draft_root:
        return settings.native_draft_root.resolve(strict=True)
    local = os.environ.get("LOCALAPPDATA")
    if not local:
        raise EditError("NATIVE_DRAFT_ROOT_REQUIRED", "Configure JY_EDIT_NATIVE_DRAFT_ROOT.")
    user = Path(local) / "JianyingPro/User Data"
    config = user / "Config/globalSetting"
    custom = None
    if config.is_file():
        match = re.search(
            r"^currentCustomDraftPath=(.+)$", config.read_text(encoding="utf-8-sig"), re.MULTILINE
        )
        if match:
            custom = match[1].strip().replace("\\\\", "\\")
    result = Path(custom) if custom else user / "Projects/com.lveditor.draft"
    if not result.is_absolute():
        raise EditError("INVALID_NATIVE_ROOT", "The configured native draft root must be absolute.")
    return result.resolve(strict=True)


def content_file(directory: Path) -> tuple[Path, Path | None]:
    """Jianying writes the effective main timeline below Timelines, leaving the root copy stale."""
    index = directory / "Timelines/project.json"
    if index.is_file():
        index = index.resolve(strict=True)
        if not index.is_relative_to(directory):
            raise EditError("NATIVE_PATH_ESCAPE", "Timeline index escapes its project directory.")
        data = read_json(index)
        timelines = [item for item in data.get("timelines", []) if not item.get("is_marked_delete")]
        if len(timelines) > 1:
            raise EditError(
                "AMBIGUOUS_NATIVE_TIMELINE", "Multiple timelines require an explicit supported selector."
            )
        timeline = data.get("main_timeline_id")
        if not isinstance(timeline, str) or not re.fullmatch(r"[a-zA-Z0-9_-]+", timeline):
            raise EditError("INVALID_TIMELINE_INDEX", "Main timeline ID is missing or invalid.")
        path = directory / "Timelines" / timeline / "draft_content.json"
    else:
        index = None
        path = directory / "draft_content.json"
    path = path.resolve(strict=True)
    if not path.is_relative_to(directory):
        raise EditError("NATIVE_PATH_ESCAPE", "Native draft content escapes its project directory.")
    return path, index


def rows(content):
    return [
        {
            "track_id": track["id"],
            "track_type": track["type"],
            "segment_id": segment["id"],
            "material_id": segment.get("material_id"),
            "target_timerange_us": segment.get("target_timerange"),
            "source_timerange_us": segment.get("source_timerange"),
            "speed": segment.get("speed"),
        }
        for track in content.get("tracks", [])
        for segment in track.get("segments", [])
    ]


class NativeDrafts:
    def __init__(self, editor):
        self.editor = editor
        self.operations = editor.root / "native-operations"
        self.operations.mkdir(exist_ok=True)

    def capabilities(self):
        directory = self.editor.settings.lyra_dir or self.editor.settings.jy_dir
        available = bool(
            directory and all((directory / name).is_file() for name in ["vebun.exe", "lyra-cli.exe"])
        )
        return {
            "backend": "lyra-cli",
            "available": available,
            "session_checked": False,
            "copy_only": True,
            "operations": [
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
            ],
            "ui_opened": False,
        }

    def cli(self, args):
        settings = self.editor.settings
        directory = settings.lyra_dir or settings.jy_dir
        if not directory or not all((directory / name).is_file() for name in ["vebun.exe", "lyra-cli.exe"]):
            raise EditError(
                "LYRA_UNAVAILABLE", "Configure JY_LYRA_INSTALL_DIR with vebun.exe and lyra-cli.exe."
            )
        runner = self.operations / ("runner-" + hashlib.sha256(RUNNER.encode()).hexdigest()[:16] + ".cjs")
        if runner.exists() and runner.read_text(encoding="utf-8") != RUNNER:
            raise EditError("RUNNER_CHANGED", "The workspace runner was modified.")
        if not runner.exists():
            try:
                with runner.open("x", encoding="utf-8", newline="\n") as stream:
                    stream.write(RUNNER)
            except FileExistsError:
                if runner.read_text(encoding="utf-8") != RUNNER:
                    raise EditError("RUNNER_CHANGED", "The workspace runner was modified.") from None
        try:
            result = subprocess.run(
                [str(directory / "vebun.exe"), str(runner), *args],
                check=False,
                cwd=directory,
                capture_output=True,
                encoding="utf-8",
                errors="replace",
                timeout=60,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise EditError(
                "LYRA_PROCESS_FAILED", "Native operation did not produce a confirmed result."
            ) from exc
        envelope = None
        for line in reversed(result.stdout.splitlines()):
            try:
                value = json.loads(line)
                if isinstance(value, dict) and "err_code" in value:
                    envelope = value
                    break
            except json.JSONDecodeError:
                continue
        if envelope is None:
            raise EditError(
                "LYRA_INVALID_RESPONSE", "No native JSON envelope returned.", exit_code=result.returncode
            )
        if result.returncode or envelope.get("err_code") != 0 or envelope.get("result") is None:
            raise EditError(
                "LYRA_OPERATION_FAILED",
                str(envelope.get("err_msg", "Native operation failed"))[:2000],
                native_error_code=envelope.get("err_code"),
                native_category=envelope.get("err_category"),
                recovery=envelope.get("recovery"),
                exit_code=result.returncode,
            )
        return envelope

    def list(self):
        response = self.cli(["draft", "project", "list"])
        return {
            "projects": response["result"].get("projects", []),
            "source": "native_jianying_projects",
            "warnings": response.get("warnings", []),
        }

    def directory(self, ref):
        root = draft_root(self.editor.settings)
        path = (root / project_name(ref)).resolve(strict=True)
        if not path.is_dir() or not path.is_relative_to(root):
            raise EditError(
                "NATIVE_PATH_ESCAPE", "Project must remain inside the configured native draft root."
            )
        return path

    def read(self, ref):
        directory = self.directory(ref)
        path, index = content_file(directory)
        fingerprint, index_hash = digest(path), digest(index) if index else None
        if path.stat().st_size > 64 * 1024 * 1024:
            raise EditError("NATIVE_DRAFT_TOO_LARGE", "Draft exceeds the read limit.")
        data = path.read_bytes()
        if hashlib.sha256(data).hexdigest() != fingerprint:
            raise EditError("NATIVE_SOURCE_CHANGED", "The saved timeline changed during reading.")
        try:
            content = json.loads(data.decode("utf-8-sig"))
        except (UnicodeError, json.JSONDecodeError):
            command, flags = native(self.editor)
            with tempfile.TemporaryDirectory(prefix="native-read-", dir=self.operations) as temp:
                source, output = Path(temp) / "input.enc", Path(temp) / "plain.json"
                source.write_bytes(data)
                run(command + ["-dc", str(source), "-o", str(output), *flags], timeout=45)
                content = read_json(output)
        current, current_index = content_file(directory)
        if (
            current != path
            or digest(path) != fingerprint
            or current_index != index
            or (index and digest(index) != index_hash)
        ):
            raise EditError(
                "NATIVE_SOURCE_CHANGED", "The saved timeline changed during reading; refresh before editing."
            )
        if not isinstance(content, dict) or not isinstance(content.get("tracks"), list):
            raise EditError("INVALID_NATIVE_DRAFT", "Native draft lacks a timeline.")
        return {
            "ref": ref,
            "directory": directory,
            "path": path,
            "sha256": fingerprint,
            "index_hash": index_hash,
            "content": content,
        }

    def inspect(self, ref, offset=0, limit=50):
        data = self.read(ref)
        segments = rows(data["content"])
        return {
            "ref": ref,
            "draft_path": str(data["directory"]),
            "content_path": str(data["path"]),
            "content_sha256": data["sha256"],
            "state_source": "last_saved_main_timeline",
            "time_unit": "integer_microseconds",
            "duration_us": data["content"].get("duration"),
            "canvas": data["content"].get("canvas_config"),
            "segment_count": len(segments),
            "segments": segments[offset : offset + limit],
            "next_offset": offset + limit if offset + limit < len(segments) else None,
        }

    @staticmethod
    def segment(content, seg_id):
        if not isinstance(seg_id, str) or not re.fullmatch(r"[a-zA-Z0-9_-]{1,100}", seg_id):
            raise EditError("INVALID_SEGMENT_ID", "Use a segment ID returned by a native draft read.")
        matches = [
            (track, segment)
            for track in content["tracks"]
            for segment in track.get("segments", [])
            if segment.get("id") == seg_id
        ]
        if len(matches) != 1:
            raise EditError("NATIVE_SEGMENT_NOT_FOUND", "Segment must uniquely belong to this native draft.")
        return matches[0]

    def inspect_clip(self, ref, seg_id):
        saved = self.read(ref)
        track, segment = self.segment(saved["content"], seg_id)
        refs = {segment.get("material_id"), *segment.get("extra_material_refs", [])} - {None, ""}
        materials = [
            {"category": category, "material": item}
            for category, group in saved["content"].get("materials", {}).items()
            if isinstance(group, list)
            for item in group
            if isinstance(item, dict) and item.get("id") in refs
        ]
        return {
            "ref": ref,
            "content_sha256": saved["sha256"],
            "state_source": "last_saved_main_timeline",
            "time_unit": "integer_microseconds",
            "track_id": track["id"],
            "track_type": track["type"],
            "segment": segment,
            "materials": materials,
            "missing_material_ids": sorted(refs - {item["material"]["id"] for item in materials}),
        }

    def operation(self, operation_id):
        path = self.operations / (checked_id(operation_id) + ".json")
        if not path.is_file():
            raise EditError("NATIVE_OPERATION_NOT_FOUND", "Unknown native operation ID.")
        receipt = read_json(path)
        return {**receipt, "receipt_path": str(path), "state_source": "last_persisted_receipt"}

    def list_operations(self, offset=0, limit=50):
        paths = sorted(
            self.operations.glob("*.json"), key=lambda p: (p.stat().st_mtime_ns, p.name), reverse=True
        )
        return {
            "operations": [
                {
                    key: value
                    for key, value in self.operation(path.stem).items()
                    if key
                    in {
                        "operation_id",
                        "operation",
                        "source_ref",
                        "output_ref",
                        "status",
                        "stage",
                        "completed_commands",
                        "command_count",
                        "receipt_path",
                        "error",
                    }
                }
                for path in paths[offset : offset + limit]
            ],
            "next_offset": offset + limit if offset + limit < len(paths) else None,
            "state_source": "last_persisted_receipts",
            "guidance": "A started receipt is not proof a process is still running. Do not replay uncertain edits blindly.",
        }

    def edit_copy(self, ref, operation, prepare, expected_content_sha256=None, reconcile=None):
        with FileLock(str(self.operations / "write.lock"), timeout=15):
            before = self.read(ref)
            if expected_content_sha256 and before["sha256"] != expected_content_sha256:
                raise EditError(
                    "NATIVE_REVISION_CONFLICT",
                    "Saved native draft changed; read it again.",
                    actual_sha256=before["sha256"],
                )
            commands, verify, parameters = prepare(before["content"])
            operation_id = uid()
            prefix = "mcp-split-" if operation == "split" else "mcp-edit-"
            output_ref = "local://" + prefix + operation_id
            receipt_path = self.operations / (operation_id + ".json")
            receipt = {
                "operation_id": operation_id,
                "operation": operation,
                "source_ref": ref,
                "output_ref": output_ref,
                "source_sha256": before["sha256"],
                "status": "started",
                "stage": "duplicating",
                "ui_opened": False,
                "render_verified": False,
                "completed_commands": 0,
                "skipped_commands": 0,
                "command_count": len(commands),
                **parameters,
            }
            write_json(receipt_path, receipt)
            try:
                # Vendor duplicate chooses new project identity; never overwrite an existing name.
                if (draft_root(self.editor.settings) / project_name(output_ref)).exists():
                    raise EditError("NATIVE_DESTINATION_EXISTS", "Generated copy name already exists.")
                duplicate = self.cli(["draft", "project", "duplicate", "--ref", ref, "--to", output_ref])
                receipt["warnings"] = duplicate.get("warnings", [])
                if duplicate["result"].get("new_ref") != output_ref:
                    raise EditError(
                        "NATIVE_DUPLICATE_MISMATCH", "Native duplication returned a different destination."
                    )
                copied = self.read(output_ref)
                if any(
                    copied["content"].get(key) != before["content"].get(key)
                    for key in ["tracks", "materials", "duration", "canvas_config"]
                ):
                    raise EditError(
                        "NATIVE_DUPLICATE_MISMATCH",
                        "The duplicated timeline differs from the requested source.",
                    )
                receipt.update(stage="mutating", affected_segments=[])
                write_json(receipt_path, receipt)

                def execute(command):
                    if command[:3] == ["draft", "segment", "move"] and "--track" not in command:
                        saved = self.read(output_ref)
                        _, item = self.segment(saved["content"], command[command.index("--seg-id") + 1])
                        start = int(command[command.index("--start") + 1].removesuffix("us"))
                        if item["target_timerange"].get("start", 0) == start:
                            receipt["skipped_commands"] += 1
                            write_json(receipt_path, receipt)
                            return
                    response = self.cli([*command, "--ref", output_ref])
                    receipt["warnings"].extend(response.get("warnings", []))
                    receipt["affected_segments"].extend(response["result"].get("affected_segments", []))
                    receipt["completed_commands"] += 1
                    write_json(receipt_path, receipt)

                for command in commands:
                    execute(command)
                after = self.read(output_ref)
                if reconcile:
                    corrections = reconcile(after["content"])
                    if corrections:
                        receipt.update(stage="reconciling", reconciliation_commands=corrections)
                        receipt["command_count"] += len(corrections)
                        write_json(receipt_path, receipt)
                        for command in corrections:
                            execute(command)
                        after = self.read(output_ref)
                receipt["stage"] = "verifying"
                write_json(receipt_path, receipt)
                verified = verify(after["content"])
                if before["content"].get("canvas_config") != after["content"].get("canvas_config"):
                    raise EditError("NATIVE_EDIT_VERIFICATION_FAILED", "Native edit changed the canvas.")
                latest = self.read(ref)
                if latest["sha256"] != before["sha256"] or latest["index_hash"] != before["index_hash"]:
                    raise EditError(
                        "NATIVE_SOURCE_CHANGED",
                        "Source was saved concurrently; the new copy is not accepted as current.",
                    )
                receipt.update(
                    **verified,
                    status="succeeded",
                    stage="verified",
                    output_path=str(after["directory"]),
                    content_path=str(after["path"]),
                    output_sha256=after["sha256"],
                    source_preserved=True,
                    placed_in_native_projects=True,
                    structure_verified=True,
                    desktop_catalog_updated=False
                    if any(w.get("code") == -100140 for w in receipt["warnings"])
                    else None,
                )
                write_json(receipt_path, receipt)
                return {
                    **receipt,
                    "receipt_path": str(receipt_path),
                    "time_unit": "integer_microseconds",
                    "guidance": "A new native project copy was edited; the original was not patched. Fully exit Jianying, then use prepare_native_copy before opening the copy. Rendering and UI opening remain separate validation steps.",
                }
            except Exception as exc:
                error = {"code": getattr(exc, "code", "NATIVE_EDIT_FAILED"), "message": str(exc)[:2000]}
                if isinstance(exc, EditError):
                    error.update(exc.details)
                receipt.update(status="failed", error=error, copy_status="unverified")
                write_json(receipt_path, receipt)
                details = {
                    "operation_id": operation_id,
                    "output_ref": output_ref,
                    "receipt_path": str(receipt_path),
                    "copy_status": "unverified",
                }
                if isinstance(exc, EditError):
                    exc.details.update(details)
                    raise
                raise EditError("NATIVE_EDIT_FAILED", str(exc)[:2000], **details) from exc

    def split(self, ref, seg_id, points, absolute=False, expected_content_sha256=None):
        if (
            not points
            or len(points) > 200
            or any(
                isinstance(x, bool) or not isinstance(x, (int, float)) or not math.isfinite(x) for x in points
            )
        ):
            raise EditError("INVALID_SPLIT_POINTS", "Supply 1..200 finite times in seconds.")
        cuts = sorted(us(point) for point in points)
        if len(set(cuts)) != len(cuts):
            raise EditError("INVALID_SPLIT_POINTS", "Cut points must be distinct at microsecond precision.")

        def prepare(content):
            track, segment = self.segment(content, seg_id)
            target = segment.get("target_timerange") or {}
            start, duration = target.get("start", 0), target.get("duration", 0)
            relative_cuts = [point - start if absolute else point for point in cuts]
            if not all(0 < point < duration for point in relative_cuts):
                raise EditError(
                    "INVALID_SPLIT_POINTS",
                    "Every cut must be strictly inside the selected segment.",
                    duration_us=duration,
                )

            def verify(after):
                affected = self.verify_split(content, after, track["id"], segment, relative_cuts)
                return {
                    "segments": affected,
                    "effective_points_us": [
                        part["target_timerange_us"].get("start", 0) - (0 if absolute else start)
                        for part in affected[1:]
                    ],
                    "boundary_tolerance_us": 1,
                }

            return (
                [
                    [
                        "draft",
                        "segment",
                        "split",
                        "--seg-id",
                        seg_id,
                        "--points",
                        ",".join(str(point) + "us" for point in cuts),
                        *(["--absolute"] if absolute else []),
                    ]
                ],
                verify,
                {"segment_id": seg_id, "points_us": cuts, "absolute": absolute},
            )

        return self.edit_copy(ref, "split", prepare, expected_content_sha256)

    @staticmethod
    def verify_split(before, after, track_id, original, cuts):
        old_track = next(t for t in before["tracks"] if t["id"] == track_id)
        new_track = next(t for t in after["tracks"] if t["id"] == track_id)
        old_ids = {segment["id"] for segment in old_track.get("segments", [])}
        parts = [
            segment
            for segment in new_track.get("segments", [])
            if segment["id"] == original["id"] or segment["id"] not in old_ids
        ]
        parts.sort(key=lambda item: item["target_timerange"].get("start", 0))
        bounds = [0, *cuts, original["target_timerange"]["duration"]]
        if len(parts) != len(bounds) - 1 or parts[0]["id"] != original["id"]:
            raise EditError(
                "NATIVE_SPLIT_VERIFICATION_FAILED",
                "Native result does not preserve the first segment and expected part count.",
            )
        source = original.get("source_timerange")
        source_end = source.get("start", 0) if source else None
        target_end = original["target_timerange"].get("start", 0)

        def materials(content):
            return {
                item["id"]: item
                for group in content.get("materials", {}).values()
                if isinstance(group, list)
                for item in group
                if isinstance(item, dict) and "id" in item
            }

        old_materials, new_materials = materials(before), materials(after)
        original_material = old_materials.get(original.get("material_id"))
        for index, part in enumerate(parts):
            target = part["target_timerange"]
            actual_start = target.get("start", 0)
            actual_end = actual_start + target["duration"]
            expected_start = original["target_timerange"].get("start", 0) + bounds[index]
            expected_end = original["target_timerange"].get("start", 0) + bounds[index + 1]
            if (
                actual_start != target_end
                or target["duration"] <= 0
                or abs(actual_start - expected_start) > 1
                or abs(actual_end - expected_end) > 1
            ):
                raise EditError(
                    "NATIVE_SPLIT_VERIFICATION_FAILED", "Timeline intervals do not match the requested cuts."
                )
            target_end = actual_end
            material = new_materials.get(part.get("material_id"))
            if (
                original_material is None
                or material is None
                or (
                    {key: value for key, value in original_material.items() if key != "id"}
                    != {key: value for key, value in material.items() if key != "id"}
                )
            ):
                raise EditError(
                    "NATIVE_SPLIT_VERIFICATION_FAILED", "Split unexpectedly changed source material content."
                )
            if source:
                interval = part.get("source_timerange", {})
                if interval.get("start", 0) != source_end or interval.get("duration", 0) <= 0:
                    raise EditError(
                        "NATIVE_SPLIT_VERIFICATION_FAILED", "Split source ranges are not contiguous."
                    )
                source_end += interval["duration"]
        if source and source_end != source.get("start", 0) + source["duration"]:
            raise EditError("NATIVE_SPLIT_VERIFICATION_FAILED", "Split lost or duplicated source duration.")
        if (
            target_end
            != original["target_timerange"].get("start", 0) + original["target_timerange"]["duration"]
        ):
            raise EditError("NATIVE_SPLIT_VERIFICATION_FAILED", "Split changed the exact timeline end.")
        untouched_before = deepcopy(before["tracks"])
        untouched_after = deepcopy(after["tracks"])
        for tracks in [untouched_before, untouched_after]:
            selected = next(t for t in tracks if t["id"] == track_id)
            selected["segments"] = [
                s for s in selected.get("segments", []) if s["id"] in old_ids and s["id"] != original["id"]
            ]
        if untouched_before != untouched_after or before.get("duration") != after.get("duration"):
            raise EditError("NATIVE_SPLIT_VERIFICATION_FAILED", "Unselected timeline content changed.")
        return [
            {
                "segment_id": part["id"],
                "target_timerange_us": part["target_timerange"],
                "source_timerange_us": part.get("source_timerange"),
            }
            for part in parts
        ]
