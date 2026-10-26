import copy
from dataclasses import replace
from itertools import pairwise

import pytest

from jy_edit_mcp.core import EditError, digest, read_json, write_json
from jy_edit_mcp.native_drafts import NativeDrafts, project_name


@pytest.fixture
def native_drafts(editor, tmp_path, monkeypatch):
    root = tmp_path / "native"
    source = root / "原生工程"
    timeline = source / "Timelines/timeline-1"
    timeline.mkdir(parents=True)
    content = {
        "id": "timeline-1",
        "duration": 5_000_000,
        "materials": {"videos": [{"id": "material-1", "path": "source.mp4", "type": "video"}]},
        "canvas_config": {"width": 320, "height": 180},
        "tracks": [
            {
                "id": "track-1",
                "type": "video",
                "segments": [
                    {
                        "id": "segment-1",
                        "material_id": "material-1",
                        "speed": 2,
                        "target_timerange": {"start": 2_000_000, "duration": 3_000_000},
                        "source_timerange": {"start": 10_000_000, "duration": 6_000_000},
                    }
                ],
            }
        ],
    }
    write_json(timeline / "draft_content.json", content)
    write_json(source / "draft_content.json", {**content, "tracks": []})  # Deliberately stale root mirror.
    write_json(
        source / "Timelines/project.json",
        {"main_timeline_id": "timeline-1", "timelines": [{"id": "timeline-1"}]},
    )
    editor.settings = replace(editor.settings, native_draft_root=root)
    adapter = NativeDrafts(editor)
    calls = []

    def cli(args):
        calls.append(args)
        if args[:3] == ["draft", "project", "duplicate"]:
            import shutil

            ref = args[args.index("--to") + 1]
            shutil.copytree(source, root / project_name(ref))
            return {"result": {"new_ref": ref}, "warnings": [{"code": -100140, "message": "catalog failed"}]}
        assert args[:3] == ["draft", "segment", "split"]
        directory = root / project_name(args[args.index("--ref") + 1])
        path = directory / "Timelines/timeline-1/draft_content.json"
        data = read_json(path)
        segment = data["tracks"][0]["segments"][0]
        cuts = [int(value[:-2]) for value in args[args.index("--points") + 1].split(",")]
        if "--absolute" in args:
            cuts = [value - segment["target_timerange"]["start"] for value in cuts]
        bounds = [0, *cuts, segment["target_timerange"]["duration"]]
        parts = []
        for index, (start, end) in enumerate(pairwise(bounds)):
            part = copy.deepcopy(segment)
            part["id"] = segment["id"] if index == 0 else "new-" + str(index)
            part["target_timerange"] = {"start": 2_000_000 + start, "duration": end - start}
            part["source_timerange"] = {"start": 10_000_000 + start * 2, "duration": (end - start) * 2}
            parts.append(part)
        data["tracks"][0]["segments"] = parts
        write_json(path, data)
        return {"result": {"affected_segments": [{"segment_id": part["id"]} for part in parts]}}

    monkeypatch.setattr(adapter, "cli", cli)
    return adapter, source, timeline / "draft_content.json", calls


@pytest.mark.parametrize("absolute,points", [(False, [1, 2]), (True, [3, 4])])
def test_native_split_new_copy_exact_units_speed_and_source_preservation(native_drafts, absolute, points):
    adapter, _source, path, calls = native_drafts
    fingerprint = digest(path)
    result = adapter.split("local://原生工程", "segment-1", points, absolute, fingerprint)
    assert result["status"] == "succeeded"
    assert result["source_preserved"] and digest(path) == fingerprint
    assert len(read_json(path)["tracks"][0]["segments"]) == 1
    assert len(result["segments"]) == 3
    assert result["segments"][0]["segment_id"] == "segment-1"
    assert result["segments"][1]["source_timerange_us"] == {"start": 12_000_000, "duration": 2_000_000}
    assert result["desktop_catalog_updated"] is False and result["ui_opened"] is False
    assert result["warnings"][0]["code"] == -100140
    assert calls[1][calls[1].index("--points") + 1] == (
        "3000000us,4000000us" if absolute else "1000000us,2000000us"
    )
    inspected = adapter.inspect(result["output_ref"], offset=1, limit=1)
    assert inspected["segment_count"] == 3 and inspected["next_offset"] == 2
    assert "Timelines" in inspected["content_path"]


@pytest.mark.parametrize("points", [[0], [3], [-1], [1, 1], [float("nan")], [True]])
def test_bad_points_do_not_create_native_copies(native_drafts, points):
    adapter, _, _, calls = native_drafts
    with pytest.raises(EditError):
        adapter.split("local://原生工程", "segment-1", points)
    assert not calls


def test_revision_wrong_segment_and_native_failure_are_explicit(native_drafts, monkeypatch):
    adapter, _, path, calls = native_drafts
    with pytest.raises(EditError, match="Saved native draft changed"):
        adapter.split("local://原生工程", "segment-1", [1], expected_content_sha256="0" * 64)
    with pytest.raises(EditError, match="uniquely"):
        adapter.split("local://原生工程", "wrong-id", [1])
    assert not calls
    original = adapter.cli

    def failed(args):
        if args[:3] == ["draft", "segment", "split"]:
            raise EditError("LYRA_OPERATION_FAILED", "split failed", native_error_code=-100110)
        return original(args)

    monkeypatch.setattr(adapter, "cli", failed)
    fingerprint = digest(path)
    with pytest.raises(EditError) as caught:
        adapter.split("local://原生工程", "segment-1", [1])
    assert caught.value.details["native_error_code"] == -100110
    receipt = read_json(adapter.operations / (caught.value.details["operation_id"] + ".json"))
    assert receipt["status"] == "failed" and digest(path) == fingerprint


def test_ref_and_timeline_boundaries(native_drafts):
    adapter, source, _, _ = native_drafts
    for ref in ["local://../secret", "file:///secret", "local://..", "local://x\\y"]:
        with pytest.raises(EditError):
            project_name(ref)
    write_json(
        source / "Timelines/project.json",
        {"main_timeline_id": "timeline-1", "timelines": [{"id": "timeline-1"}, {"id": "other"}]},
    )
    with pytest.raises(EditError, match="Multiple timelines"):
        adapter.inspect("local://原生工程")


def test_new_native_material_id_is_valid_only_for_identical_material(native_drafts):
    adapter, _, _, _ = native_drafts
    before = adapter.read("local://原生工程")["content"]
    after = copy.deepcopy(before)
    original = before["tracks"][0]["segments"][0]
    left, right = copy.deepcopy(original), copy.deepcopy(original)
    left["target_timerange"]["duration"] = 1_000_000
    left["source_timerange"]["duration"] = 2_000_000
    right.update(id="new-id", material_id="new-material")
    right["target_timerange"] = {"start": 3_000_000, "duration": 2_000_000}
    right["source_timerange"] = {"start": 12_000_000, "duration": 4_000_000}
    after["tracks"][0]["segments"] = [left, right]
    after["materials"]["videos"].append({**before["materials"]["videos"][0], "id": "new-material"})
    assert len(adapter.verify_split(before, after, "track-1", original, [1_000_000])) == 2
    after["materials"]["videos"][1]["path"] = "different.mp4"
    with pytest.raises(EditError, match="material content"):
        adapter.verify_split(before, after, "track-1", original, [1_000_000])


def test_one_microsecond_boundary_normalization_still_requires_continuity(native_drafts):
    adapter, _, _, _ = native_drafts
    result = adapter.split("local://原生工程", "segment-1", [1])
    before = adapter.read("local://原生工程")["content"]
    after = adapter.read(result["output_ref"])["content"]
    original = before["tracks"][0]["segments"][0]
    left, right = after["tracks"][0]["segments"]
    left["target_timerange"]["duration"] -= 1
    right["target_timerange"]["start"] -= 1
    right["target_timerange"]["duration"] += 1
    left["source_timerange"]["duration"] -= 2
    right["source_timerange"]["start"] -= 2
    right["source_timerange"]["duration"] += 2
    assert len(adapter.verify_split(before, after, "track-1", original, [1_000_000])) == 2
    right["target_timerange"]["start"] += 1
    right["target_timerange"]["duration"] -= 1
    with pytest.raises(EditError, match="intervals"):
        adapter.verify_split(before, after, "track-1", original, [1_000_000])
    right["target_timerange"]["start"] -= 2
    right["target_timerange"]["duration"] += 2
    left["target_timerange"]["duration"] -= 1
    with pytest.raises(EditError, match="intervals"):
        adapter.verify_split(before, after, "track-1", original, [1_000_000])
