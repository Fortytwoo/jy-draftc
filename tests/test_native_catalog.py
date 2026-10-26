import copy
from pathlib import Path

import pytest
from test_native_drafts import native_drafts as source_fixture

from jy_edit_mcp import native_catalog
from jy_edit_mcp.core import EditError, digest, read_json, write_json


@pytest.fixture
def native_drafts(editor, tmp_path, monkeypatch):
    return source_fixture.__wrapped__(editor, tmp_path, monkeypatch)


def setup_copy(native_drafts, monkeypatch, registered=True):
    adapter, source, _path, _ = native_drafts
    write_json(
        source / "draft_meta_info.json",
        {
            "draft_id": "source-id",
            "draft_name": source.name,
            "draft_fold_path": source.as_posix(),
            "draft_root_path": source.parent.as_posix(),
            "draft_materials": [{"keep": "material"}],
        },
    )
    result = adapter.split("local://原生工程", "segment-1", [1, 2])
    output = adapter.directory(result["output_ref"])
    write_json(output / "draft_content.json.bak", {"old": "recovery"})
    original_entry = {
        "draft_id": "source-id",
        "draft_name": source.name,
        "draft_fold_path": source.as_posix(),
        "extra": {"keep": 1},
    }
    entries = [original_entry]
    if registered:
        entries.append(
            {
                "draft_id": "copy-id",
                "draft_name": output.name,
                "draft_fold_path": output.as_posix(),
                "custom": "preserve",
            }
        )
    write_json(
        source.parent / "root_meta_info.json",
        {"all_draft_store": entries, "draft_ids": 4, "custom": {"opaque": True}},
    )
    monkeypatch.setattr(native_catalog, "ensure_editor_closed", lambda: None)
    return adapter, source, output, result, copy.deepcopy(entries)


@pytest.mark.parametrize("registered", [False, True])
def test_prepare_only_copy_identity_mirror_and_catalog(native_drafts, monkeypatch, registered):
    adapter, source, output, result, entries = setup_copy(native_drafts, monkeypatch, registered)
    source_before = {p: p.read_bytes() for p in source.rglob("*") if p.is_file()}
    timeline_before = adapter.read(result["output_ref"])["sha256"]
    report = native_catalog.prepare_copy(adapter, result["output_ref"])
    assert report["source_preserved"] and report["desktop_catalog_updated"] and not report["ui_opened"]
    assert report["segment_count"] == 3
    meta = read_json(output / "draft_meta_info.json")
    assert meta["draft_id"] != "source-id" and meta["draft_name"] == output.name
    assert meta["draft_fold_path"] == output.as_posix()
    assert meta["draft_materials"] == [{"keep": "material"}]
    catalog = read_json(source.parent / "root_meta_info.json")
    assert catalog["draft_ids"] == 4 and catalog["custom"] == {"opaque": True}
    assert catalog["all_draft_store"][0] == entries[0]
    entry = catalog["all_draft_store"][1]
    assert entry["draft_id"] == meta["draft_id"]
    if registered:
        assert entry["custom"] == "preserve" and entry["draft_id"] == "copy-id"
    assert digest(output / "draft_content.json") == timeline_before
    assert digest(output / "draft_content.json.bak") == timeline_before
    assert adapter.read(result["output_ref"])["sha256"] == timeline_before
    assert all(p.read_bytes() == data for p, data in source_before.items())
    assert read_json(Path(report["backup_path"]) / "receipt.json")["status"] == "prepared"


@pytest.mark.parametrize("operation", ["remove", "speed", "subtitles"])
def test_prepare_generalized_native_edit_copy(native_drafts, monkeypatch, operation):
    adapter, source, output, result, _ = setup_copy(native_drafts, monkeypatch, registered=False)
    destination = output.with_name(output.name.replace("mcp-split-", "mcp-edit-", 1))
    output.rename(destination)
    ref = "local://" + destination.name
    receipt_path = Path(result["receipt_path"])
    receipt = read_json(receipt_path)
    receipt.update(operation=operation, output_ref=ref, output_path=str(destination))
    write_json(receipt_path, receipt)
    before = digest(source / "Timelines/timeline-1/draft_content.json")
    report = native_catalog.prepare_copy(adapter, ref)
    assert report["source_preserved"] and report["desktop_catalog_updated"]
    assert report["ref"] == ref
    assert digest(source / "Timelines/timeline-1/draft_content.json") == before
    receipt["operation"] = "unrecognized"
    write_json(receipt_path, receipt)
    with pytest.raises(EditError, match="successful native edit receipt"):
        native_catalog.prepare_copy(adapter, ref)


def test_editor_running_and_changed_copy_do_not_write(native_drafts, monkeypatch):
    adapter, source, _output, result, _ = setup_copy(native_drafts, monkeypatch)
    before = {p: p.read_bytes() for p in source.parent.rglob("*") if p.is_file()}

    def running():
        raise EditError("NATIVE_EDITOR_RUNNING", "running")

    monkeypatch.setattr(native_catalog, "ensure_editor_closed", running)
    with pytest.raises(EditError, match="running"):
        native_catalog.prepare_copy(adapter, result["output_ref"])
    assert all(p.read_bytes() == data for p, data in before.items())
    monkeypatch.setattr(native_catalog, "ensure_editor_closed", lambda: None)
    timeline = adapter.read(result["output_ref"])["path"]
    timeline.write_text(timeline.read_text(encoding="utf-8") + " ", encoding="utf-8")
    with pytest.raises(EditError, match="changed"):
        native_catalog.prepare_copy(adapter, result["output_ref"])
    with pytest.raises(EditError, match="Only verified"):
        native_catalog.prepare_copy(adapter, "local://原生工程")


def test_catalog_identity_conflict_is_rejected(native_drafts, monkeypatch):
    adapter, source, _output, result, _ = setup_copy(native_drafts, monkeypatch)
    catalog = read_json(source.parent / "root_meta_info.json")
    catalog["all_draft_store"][1]["draft_id"] = "source-id"
    write_json(source.parent / "root_meta_info.json", catalog)
    with pytest.raises(EditError, match="unique"):
        native_catalog.prepare_copy(adapter, result["output_ref"])


def test_publish_failure_rolls_back_copy_files(native_drafts, monkeypatch):
    adapter, source, _output, result, _ = setup_copy(native_drafts, monkeypatch)
    before = {p: p.read_bytes() for p in source.parent.rglob("*") if p.is_file()}
    atomic = native_catalog.atomic_bytes
    failed = False

    def fail_catalog(path, data):
        nonlocal failed
        if path.name == "root_meta_info.json" and not failed:
            failed = True
            raise OSError("simulated catalog replacement failure")
        return atomic(path, data)

    monkeypatch.setattr(native_catalog, "atomic_bytes", fail_catalog)
    with pytest.raises(OSError, match="simulated"):
        native_catalog.prepare_copy(adapter, result["output_ref"])
    assert all(p.read_bytes() == data for p, data in before.items())
