"""Offline, receipt-scoped preparation of a verified native copy for the editor."""

from __future__ import annotations

import json
import os
import tempfile
import uuid
from copy import deepcopy
from pathlib import Path

from filelock import FileLock

from .core import EditError, digest, read_json, run, uid, write_json
from .template_tools import native


def ensure_editor_closed():
    if os.name != "nt":
        raise EditError("NATIVE_OFFLINE_CHECK_UNAVAILABLE", "Offline preparation requires Windows.")
    command = (
        "$ErrorActionPreference='Stop';"
        "$p=@(Get-CimInstance Win32_Process | Where-Object {"
        "$_.Name -match '^(JianyingPro|JianyingProBeta|CapCut)\\.exe$'});"
        "ConvertTo-Json -InputObject @($p | ForEach-Object {$_.ProcessId}) -Compress"
    )
    response = run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", command], timeout=20)
    try:
        processes = json.loads(response.stdout)
    except (ValueError, TypeError) as exc:
        raise EditError("NATIVE_OFFLINE_CHECK_UNAVAILABLE", "Could not confirm editor shutdown.") from exc
    if not isinstance(processes, list):
        raise EditError("NATIVE_OFFLINE_CHECK_UNAVAILABLE", "Unexpected editor process response.")
    if processes:
        raise EditError(
            "NATIVE_EDITOR_RUNNING",
            "Fully exit Jianying before preparing its project catalog; Harness may remain open.",
            process_ids=processes,
        )


def decode(adapter, data):
    try:
        value = json.loads(data.decode("utf-8-sig"))
        encrypted = False
    except (ValueError, UnicodeError):
        command, flags = native(adapter.editor)
        with tempfile.TemporaryDirectory(prefix="catalog-decode-", dir=adapter.operations) as temp:
            source, output = Path(temp) / "input.enc", Path(temp) / "output.json"
            source.write_bytes(data)
            run(command + ["-dc", str(source), "-o", str(output), *flags], timeout=45)
            value = read_json(output)
        encrypted = True
    if not isinstance(value, dict):
        raise EditError("INVALID_NATIVE_METADATA", "Native metadata must be an object.")
    return value, encrypted


def encode(adapter, document, encrypted):
    """Prefer native encoding; metadata may be emitted as plain JSON by the converter.

    Its -ec command encrypts only draft-content schemas. Callers must report the
    actual output encoding, retain original bytes, and leave UI compatibility pending.
    """
    data = json.dumps(document, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if not encrypted:
        return data
    command, flags = native(adapter.editor)
    with tempfile.TemporaryDirectory(prefix="catalog-encode-", dir=adapter.operations) as temp:
        source, output = Path(temp) / "input.json", Path(temp) / "output.enc"
        source.write_bytes(data)
        run(command + ["-ec", str(source), "-o", str(output), *flags], timeout=45)
        result = output.read_bytes()
        if decode(adapter, result)[0] != document:
            raise EditError("NATIVE_METADATA_ROUNDTRIP_FAILED", "Metadata encryption did not round-trip.")
        return result


def checked_file(directory, name):
    candidate = directory / name
    if candidate.is_symlink() or not candidate.is_file() or not candidate.resolve().is_relative_to(directory):
        raise EditError("INVALID_NATIVE_METADATA_PATH", "Expected a regular native metadata file.")
    return candidate


def atomic_bytes(path, data):
    temp = path.with_name(path.name + "." + uid() + ".tmp")
    try:
        with temp.open("xb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)


def prepare_copy(adapter, ref, expected_content_sha256=None):
    """Change only a receipt-proven copy's metadata/mirror and its own catalog entry."""
    from .native_drafts import project_name

    name = project_name(ref)
    prefix = "mcp-split-" if name.startswith("mcp-split-") else "mcp-edit-"
    operation_id = name.removeprefix(prefix)
    if (
        name != prefix + operation_id
        or len(operation_id) != 32
        or any(c not in "0123456789abcdef" for c in operation_id)
    ):
        raise EditError(
            "NATIVE_COPY_RECEIPT_REQUIRED",
            "Only verified service-generated native edit copies may be prepared.",
        )
    receipt = read_json(adapter.operations / (operation_id + ".json"))
    if (
        receipt.get("output_ref") != ref
        or receipt.get("source_ref") == ref
        or receipt.get("status") != "succeeded"
        or (prefix == "mcp-edit-" and receipt.get("operation") not in {"remove", "speed", "subtitles"})
    ):
        raise EditError(
            "NATIVE_COPY_RECEIPT_REQUIRED",
            "A successful native edit receipt for this exact copy is required.",
        )
    with FileLock(str(adapter.operations / "write.lock"), timeout=15):
        ensure_editor_closed()
        saved = adapter.read(ref)
        expected = expected_content_sha256 or receipt.get("output_sha256")
        if saved["sha256"] != expected or saved["sha256"] != receipt.get("output_sha256"):
            raise EditError(
                "NATIVE_REVISION_CONFLICT", "The copy changed after editing; preparation was not applied."
            )
        source = adapter.read(receipt["source_ref"])
        directory = saved["directory"]
        from .native_drafts import draft_root

        expected_directory = draft_root(adapter.editor.settings) / name
        if expected_directory.is_symlink() or directory != expected_directory:
            raise EditError("INVALID_NATIVE_METADATA_PATH", "Copy preparation does not follow project links.")
        root = directory.parent
        meta_path = checked_file(directory, "draft_meta_info.json")
        catalog_path = checked_file(root, "root_meta_info.json")
        mirror_path = checked_file(directory, "draft_content.json")
        originals = {path: path.read_bytes() for path in [meta_path, mirror_path, catalog_path]}
        meta, meta_encrypted = decode(adapter, originals[meta_path])
        catalog, catalog_encrypted = decode(adapter, originals[catalog_path])
        entries = catalog.get("all_draft_store")
        if not isinstance(entries, list) or not all(isinstance(item, dict) for item in entries):
            raise EditError("INVALID_NATIVE_CATALOG", "Native catalog entries are invalid.")
        source_meta, _ = decode(
            adapter, checked_file(source["directory"], "draft_meta_info.json").read_bytes()
        )
        matches = [item for item in entries if item.get("draft_name") == name]
        if len(matches) > 1 or any(
            Path(item.get("draft_fold_path", "")).resolve() != directory for item in matches
        ):
            raise EditError("AMBIGUOUS_NATIVE_CATALOG", "Copy name or path has conflicting catalog entries.")
        entry = matches[0] if matches else None
        if any(
            item is not entry and Path(item.get("draft_fold_path", "")).resolve() == directory
            for item in entries
        ):
            raise EditError("AMBIGUOUS_NATIVE_CATALOG", "Copy path has a conflicting catalog identity.")
        draft_id = entry.get("draft_id") if entry else str(uuid.uuid4()).upper()
        if (
            not isinstance(draft_id, str)
            or not draft_id
            or draft_id == source_meta.get("draft_id")
            or any(item is not entry and item.get("draft_id") == draft_id for item in entries)
        ):
            raise EditError("NATIVE_IDENTITY_CONFLICT", "The copy must have a unique project identity.")
        updated_meta = deepcopy(meta)
        identity = {
            "draft_id": draft_id,
            "draft_name": name,
            "draft_fold_path": directory.as_posix(),
            "draft_root_path": root.as_posix(),
        }
        updated_meta.update(identity)
        updated_meta["tm_duration"] = saved["content"].get("duration", meta.get("tm_duration"))
        updated_catalog = deepcopy(catalog)
        if entry is None:
            source_entries = [item for item in entries if item.get("draft_id") == source_meta.get("draft_id")]
            if len(source_entries) != 1:
                raise EditError(
                    "AMBIGUOUS_NATIVE_CATALOG", "Cannot derive the copy catalog entry from its source."
                )
            updated_entry = deepcopy(source_entries[0])
            updated_catalog["all_draft_store"].append(updated_entry)
        else:
            updated_entry = updated_catalog["all_draft_store"][entries.index(entry)]
        updated_entry.update(identity)
        updated_entry.update(
            draft_cover=(directory / "draft_cover.jpg").as_posix(),
            draft_json_file=mirror_path.as_posix(),
            tm_duration=updated_meta["tm_duration"],
        )
        staged = {
            meta_path: encode(adapter, updated_meta, meta_encrypted),
            mirror_path: saved["path"].read_bytes(),
            catalog_path: encode(adapter, updated_catalog, catalog_encrypted),
        }
        # Keep a previous recovery mirror coherent, retaining its old bytes in the backup.
        recovery = directory / "draft_content.json.bak"
        if recovery.exists():
            recovery = checked_file(directory, recovery.name)
            originals[recovery] = recovery.read_bytes()
            staged[recovery] = staged[mirror_path]
        backup = adapter.operations / ("prepare-" + uid())
        backup.mkdir()
        for index, (path, data) in enumerate(originals.items()):
            (backup / f"{index}-{path.name}").write_bytes(data)
        report = {
            "ref": ref,
            "source_ref": receipt["source_ref"],
            "draft_id": draft_id,
            "backup_path": str(backup),
            "content_sha256": saved["sha256"],
            "ui_opened": False,
            "status": "prepared",
            "desktop_catalog_updated": True,
            "metadata_input_encrypted": meta_encrypted,
            "metadata_output_encrypted": decode(adapter, staged[meta_path])[1],
            "catalog_input_encrypted": catalog_encrypted,
            "catalog_output_encrypted": decode(adapter, staged[catalog_path])[1],
            "segment_count": sum(len(t.get("segments", [])) for t in saved["content"]["tracks"]),
        }
        write_json(
            backup / "receipt.json", {**report, "status": "started", "paths": [str(p) for p in originals]}
        )
        changed = []
        try:
            ensure_editor_closed()
            if (
                any(path.read_bytes() != data for path, data in originals.items())
                or adapter.read(ref)["sha256"] != saved["sha256"]
            ):
                raise EditError(
                    "NATIVE_SOURCE_CHANGED", "Native files changed while preparing; no writes were made."
                )
            # Publish the global catalog last. No source project file is in this write set.
            order = [p for p in staged if p != catalog_path] + [catalog_path]
            for path in order:
                if staged[path] != originals[path]:
                    atomic_bytes(path, staged[path])
                    changed.append(path)
            if adapter.read(ref)["sha256"] != saved["sha256"] or digest(source["path"]) != source["sha256"]:
                raise EditError("NATIVE_SOURCE_CHANGED", "A saved timeline changed during preparation.")
            if (
                decode(adapter, meta_path.read_bytes())[0] != updated_meta
                or decode(adapter, catalog_path.read_bytes())[0] != updated_catalog
            ):
                raise EditError("NATIVE_PREPARATION_VERIFICATION_FAILED", "Metadata readback differs.")
            if mirror_path.read_bytes() != saved["path"].read_bytes():
                raise EditError(
                    "NATIVE_PREPARATION_VERIFICATION_FAILED", "Root and main timeline mirrors differ."
                )
            write_json(
                backup / "receipt.json",
                {**report, "changed_paths": [str(p) for p in changed], "source_preserved": True},
            )
            return {
                **report,
                "source_preserved": True,
                "guidance": "Catalog and copy metadata were read back. Reopen Jianying to verify the copy opens; UI acceptance is still pending.",
            }
        except Exception as exc:
            rollback_conflicts = []
            for path in reversed(changed):
                if path.read_bytes() == staged[path]:
                    atomic_bytes(path, originals[path])
                else:
                    rollback_conflicts.append(str(path))
            write_json(
                backup / "receipt.json",
                {**report, "status": "failed", "error": str(exc), "rollback_conflicts": rollback_conflicts},
            )
            raise
