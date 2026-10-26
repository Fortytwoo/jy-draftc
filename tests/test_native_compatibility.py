"""Compatibility regressions derived from actual vendor CLI readback."""

import copy

import pytest
from test_native_edits import SOURCE_REF, TIMELINE_PATH
from test_native_edits import native_edits as source_fixture

from jy_edit_mcp.core import EditError, read_json, write_json
from jy_edit_mcp.native_drafts import project_name
from jy_edit_mcp.native_edits import normalize_ranges, remove_clip, set_speed


@pytest.fixture
def native_edits(tmp_path, monkeypatch):
    return source_fixture.__wrapped__(tmp_path, monkeypatch)


def test_proto_zero_and_empty_fields_are_equivalent_without_changing_input():
    document = {
        "tracks": [
            {"id": "empty"},
            {
                "id": "video",
                "segments": [
                    {
                        "source_timerange": {"duration": 3},
                        "target_timerange": {"duration": 2},
                    }
                ],
            },
        ]
    }
    before = copy.deepcopy(document)
    normalized = normalize_ranges(document)
    assert document == before
    assert normalized["tracks"][0]["segments"] == []
    assert normalized["tracks"][1]["segments"][0]["target_timerange"] == {"start": 0, "duration": 2}


def test_vendor_omitted_empty_track_is_accepted(native_edits):
    lab = native_edits

    def omit(content):
        for track in content["tracks"]:
            if not track["segments"]:
                track.pop("segments")

    lab.cli.corrupt = omit
    result = remove_clip(lab.adapter, SOURCE_REF, "audio-clip")
    assert result["status"] == "succeeded"


@pytest.mark.parametrize("has_payload", [False, True])
def test_only_new_truly_empty_animation_placeholder_is_ignored(native_edits, has_payload):
    lab = native_edits

    def placeholder(content):
        value = {"id": "new-animation", "type": "sticker_animation"}
        if has_payload:
            value["animations"] = [{"type": "in", "duration": 100000}]
        content["materials"]["material_animations"] = [value]
        segment = lab.adapter.segment(content, "earlier")[1]
        segment["extra_material_refs"].append("new-animation")
        for track in content["tracks"]:
            for item in track["segments"]:
                for key in ["target_timerange", "source_timerange"]:
                    if item.get(key, {}).get("start") == 0:
                        item[key].pop("start")

    lab.cli.corrupt = placeholder
    if has_payload:
        with pytest.raises(EditError, match="unrelated effect references"):
            set_speed(lab.adapter, SOURCE_REF, "earlier", speed=2)
    else:
        result = set_speed(lab.adapter, SOURCE_REF, "earlier", speed=2)
        assert result["status"] == "succeeded"
        saved = lab.adapter.read(result["output_ref"])["content"]
        assert saved["materials"]["material_animations"][0]["id"] == "new-animation"


def test_implicit_ripple_skips_noop_moves_and_restores_other_track(native_edits, monkeypatch):
    lab = native_edits
    original_cli = lab.cli

    def cli(args):
        response = original_cli(args)
        if args[:3] == ["draft", "segment", "remove"]:
            path = lab.root / project_name(args[args.index("--ref") + 1]) / TIMELINE_PATH
            content = read_json(path)
            for track in content["tracks"]:
                for segment in track["segments"]:
                    if segment["target_timerange"]["start"] >= 5_000_000:
                        segment["target_timerange"]["start"] -= 3_000_000
            content["duration"] = max(
                s["target_timerange"]["start"] + s["target_timerange"]["duration"]
                for t in content["tracks"]
                for s in t["segments"]
            )
            write_json(path, content)
        return response

    monkeypatch.setattr(lab.adapter, "cli", cli)
    result = remove_clip(lab.adapter, SOURCE_REF, "selected", ripple=True)
    assert result["status"] == "succeeded"
    assert result["completed_commands"] == 2 and result["skipped_commands"] == 2
    assert result["command_count"] == 4
    saved = lab.adapter.read(result["output_ref"])["content"]
    assert lab.adapter.segment(saved, "cross-track")[1] == lab.adapter.segment(lab.original, "cross-track")[1]
    assert lab.adapter.read(SOURCE_REF)["content"] == lab.original
