"""Offline regressions for native copy-on-write edits and persisted receipts."""

import copy
import json
import os
import shutil
from itertools import pairwise
from types import SimpleNamespace

import pytest
from pydantic import ValidationError

from jy_edit_mcp.core import EditError, Settings, digest, read_json, write_json
from jy_edit_mcp.native_drafts import NativeDrafts, project_name
from jy_edit_mcp.native_edits import CurvePoint, SubtitleCue, add_subtitles, remove_clip, set_speed

SOURCE_REF = "local://原生编辑工程"
TIMELINE_PATH = "Timelines/timeline-1/draft_content.json"
CURVE_POINTS = [{"x": 0, "y": 2}, {"x": 0.333333, "y": 4}, {"x": 1, "y": 2}]


def _snapshot(directory):
    return {
        str(path.relative_to(directory)): path.read_bytes() for path in directory.rglob("*") if path.is_file()
    }


def _segment(content, segment_id):
    matches = [
        (track, item) for track in content["tracks"] for item in track["segments"] if item["id"] == segment_id
    ]
    assert len(matches) == 1
    return matches[0]


def _material(content, material_id):
    matches = [item for group in content["materials"].values() for item in group if item["id"] == material_id]
    assert len(matches) == 1
    return matches[0]


class SimulatedNativeCLI:
    """Modify saved main timelines, never derive success from a canned CLI reply."""

    def __init__(self, adapter, root):
        self.adapter = adapter
        self.root = root
        self.calls = []
        self.progress = []
        self.mutation_count = 0
        self.fail_at = None
        self.skip_mutation = False
        self.prune_empty_track = False
        self.corrupt = None

    @staticmethod
    def option(args, flag):
        return args[args.index(flag) + 1]

    @classmethod
    def microseconds(cls, args, flag):
        value = cls.option(args, flag)
        assert value.endswith("us"), (flag, value)
        result = int(value[:-2])
        assert value == f"{result}us"
        return result

    def __call__(self, args):
        self.calls.append(list(args))
        duplicate = args[:3] == ["draft", "project", "duplicate"]
        output_ref = self.option(args, "--to" if duplicate else "--ref")
        operation_id = project_name(output_ref).rsplit("-", 1)[-1]
        self.progress.append(self.adapter.operation(operation_id))
        if duplicate:
            # Chained edits must copy their supplied ref, not the fixture's original source.
            source_ref = self.option(args, "--ref")
            shutil.copytree(self.root / project_name(source_ref), self.root / project_name(output_ref))
            return {
                "err_code": 0,
                "result": {"new_ref": output_ref},
                "warnings": [{"code": -100140, "message": "simulated catalog failure"}],
            }

        self.mutation_count += 1
        if self.mutation_count == self.fail_at:
            raise EditError(
                "LYRA_OPERATION_FAILED",
                "simulated second native command failure",
                native_error_code=-100110,
                native_category="operation",
                recovery="inspect the saved copy before retrying",
            )
        path = self.root / project_name(output_ref) / TIMELINE_PATH
        content = read_json(path)
        segment_id = (
            self.option(args, "--seg-id") if "--seg-id" in args else f"subtitle-{self.mutation_count}"
        )
        if not self.skip_mutation:
            if args[:3] == ["draft", "segment", "remove"]:
                track, segment = _segment(content, segment_id)
                track["segments"].remove(segment)
                if self.prune_empty_track and not track["segments"]:
                    content["tracks"].remove(track)
            elif args[:3] == ["draft", "segment", "move"]:
                _, segment = _segment(content, segment_id)
                segment["target_timerange"]["start"] = self.microseconds(args, "--start")
            elif args[:3] == ["draft", "video", "speed"]:
                self.speed(content, segment_id, args)
            elif args[:3] == ["draft", "subtitle", "add"]:
                self.subtitle(content, segment_id, args)
            else:
                pytest.fail(f"Unexpected simulated native command: {args!r}")
            content["duration"] = max(
                (
                    item["target_timerange"]["start"] + item["target_timerange"]["duration"]
                    for track in content["tracks"]
                    for item in track["segments"]
                ),
                default=0,
            )
        if self.corrupt:
            self.corrupt(content)
        write_json(path, content)
        # Even fault-injection cases claim success and an affected segment.
        return {"err_code": 0, "result": {"affected_segments": [{"segment_id": segment_id}]}}

    def speed(self, content, segment_id, args):
        _, segment = _segment(content, segment_id)
        saved = {"id": f"simulated-speed-{self.mutation_count}", "mode": 0, "curve_speed": None}
        if "--speed" in args:
            speed = float(self.option(args, "--speed"))
        else:
            points = (
                json.loads(self.option(args, "--curve-points"))
                if "--curve-points" in args
                else [{"x": 0.0, "y": 2.0}, {"x": 0.5, "y": 4.0}, {"x": 1.0, "y": 2.0}]
            )
            # Deterministic fixture math, not a claim to reproduce a vendor preset's integral.
            speed = sum((b["x"] - a["x"]) * (a["y"] + b["y"]) / 2 for a, b in pairwise(points))
            saved.update(mode=1, curve_speed={"speed_points": points})
            if "--curve-name" in args:
                saved["curve_speed"]["name"] = self.option(args, "--curve-name")
        saved["speed"] = speed
        speed_ids = {item["id"] for item in content["materials"]["speeds"]}
        segment["extra_material_refs"] = [
            rid for rid in segment.get("extra_material_refs", []) if rid not in speed_ids
        ]
        segment["extra_material_refs"].append(saved["id"])
        content["materials"]["speeds"].append(saved)
        segment["speed"] = speed
        segment["target_timerange"]["duration"] = round(segment["source_timerange"]["duration"] / speed)

    def subtitle(self, content, segment_id, args):
        track = next((track for track in content["tracks"] if track["id"] == "added-subtitles"), None)
        if track is None:
            track = {"id": "added-subtitles", "type": "text", "segments": []}
            content["tracks"].append(track)
        material_id = f"text-{segment_id}"
        content["materials"]["texts"].append(
            {
                "id": material_id,
                "content": json.dumps(
                    {"text": self.option(args, "--content"), "styles": []}, ensure_ascii=False
                ),
            }
        )
        track["segments"].append(
            {
                "id": segment_id,
                "material_id": material_id,
                "target_timerange": {
                    "start": self.microseconds(args, "--start"),
                    "duration": self.microseconds(args, "--duration"),
                },
            }
        )


@pytest.fixture
def native_edits(tmp_path, monkeypatch):
    root = tmp_path / "native"
    source = root / project_name(SOURCE_REF)
    path = source / TIMELINE_PATH

    def video(segment_id, start, duration, material_id="video-shared", speed=1, source_in=0, refs=()):
        return {
            "id": segment_id,
            "material_id": material_id,
            "speed": speed,
            "target_timerange": {"start": start, "duration": duration},
            "source_timerange": {"start": source_in, "duration": duration * speed},
            "extra_material_refs": list(refs),
            "volume": 1.0,
        }

    content = {
        "id": "timeline-1",
        "duration": 12_000_000,
        "canvas_config": {"width": 320, "height": 180},
        "materials": {
            "videos": [{"id": "video-shared", "path": "source.mp4", "type": "video"}],
            "audios": [{"id": "audio-existing", "path": "source.wav", "type": "audio"}],
            "texts": [{"id": "text-existing", "content": json.dumps({"text": "原有字幕"})}],
            "speeds": [
                {"id": "speed-selected", "mode": 0, "speed": 2, "curve_speed": None},
                {"id": "speed-shared", "mode": 0, "speed": 1, "curve_speed": None},
            ],
            "effects": [{"id": "effect-selected", "value": 10}, {"id": "effect-shared", "value": 20}],
        },
        "tracks": [
            {
                "id": "main-video",
                "type": "video",
                "name": "主轨",
                "segments": [
                    video("earlier", 0, 1_000_000),
                    video(
                        "selected",
                        2_000_000,
                        3_000_000,
                        speed=2,
                        source_in=10_000_000,
                        refs=["speed-selected", "effect-selected"],
                    ),
                    video(
                        "later-1",
                        6_000_000,
                        2_000_000,
                        source_in=20_000_000,
                        refs=["speed-shared", "effect-shared"],
                    ),
                    video("later-2", 10_000_000, 2_000_000, source_in=30_000_000),
                ],
            },
            {
                "id": "other-video",
                "type": "video",
                "segments": [
                    video("cross-track", 6_000_000, 2_500_000, refs=["speed-shared", "effect-shared"]),
                ],
            },
            {
                "id": "audio-track",
                "type": "audio",
                "segments": [
                    {
                        "id": "audio-clip",
                        "material_id": "audio-existing",
                        "extra_material_refs": ["effect-shared"],
                        "target_timerange": {"start": 4_000_000, "duration": 3_000_000},
                        "source_timerange": {"start": 0, "duration": 3_000_000},
                    }
                ],
            },
            {
                "id": "existing-text",
                "type": "text",
                "segments": [
                    {
                        "id": "old-subtitle",
                        "material_id": "text-existing",
                        "target_timerange": {"start": 500_000, "duration": 1_000_000},
                    }
                ],
            },
        ],
    }
    write_json(path, content)
    write_json(source / "draft_content.json", {**content, "tracks": []})  # Stale root mirror.
    write_json(
        source / "Timelines/project.json",
        {
            "main_timeline_id": "timeline-1",
            "timelines": [{"id": "timeline-1"}],
        },
    )
    write_json(source / "draft_meta_info.json", {"draft_name": "原生编辑工程", "fixture": True})
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    # No Editor/media fixture, subprocesses, installed Jianying, env discovery, or catalog dependency.
    editor = SimpleNamespace(
        root=workspace,
        settings=Settings(
            workspace,
            (tmp_path,),
            "UNUSED_FFMPEG",
            "UNUSED_FFPROBE",
            native_draft_root=root,
        ),
    )
    adapter = NativeDrafts(editor)
    cli = SimulatedNativeCLI(adapter, root)
    monkeypatch.setattr(adapter, "cli", cli)
    return SimpleNamespace(
        adapter=adapter,
        cli=cli,
        root=root,
        source=source,
        path=path,
        original=content,
        source_files=_snapshot(source),
    )


def _assert_source_preserved(lab):
    assert _snapshot(lab.source) == lab.source_files
    assert lab.adapter.read(SOURCE_REF)["content"] == lab.original


def _assert_success(lab, result, command_count=1):
    assert result["status"] == "succeeded" and result["stage"] == "verified"
    assert result["completed_commands"] == result["command_count"] == command_count
    assert result["source_preserved"] and result["structure_verified"]
    assert result["ui_opened"] is False and result["render_verified"] is False
    assert result["desktop_catalog_updated"] is False
    assert result["warnings"] == [{"code": -100140, "message": "simulated catalog failure"}]
    assert result["output_ref"] != SOURCE_REF
    assert result["time_unit"] == "integer_microseconds"
    output = lab.adapter.read(result["output_ref"])
    assert output["path"] == lab.root / project_name(result["output_ref"]) / TIMELINE_PATH
    assert result["output_sha256"] == digest(output["path"])
    assert read_json(output["directory"] / "draft_content.json")["tracks"] == []
    receipt = NativeDrafts(lab.adapter.editor).operation(result["operation_id"])
    assert receipt["status"] == "succeeded" and receipt["output_sha256"] == result["output_sha256"]
    _assert_source_preserved(lab)
    return output["content"]


def _assert_failed(lab, error, completed=1, command_count=1, stage="verifying"):
    receipt = NativeDrafts(lab.adapter.editor).operation(error.details["operation_id"])
    assert receipt["status"] == "failed" and receipt["stage"] == stage
    assert receipt["copy_status"] == error.details["copy_status"] == "unverified"
    assert receipt["completed_commands"] == completed and receipt["command_count"] == command_count
    assert receipt["output_ref"] == error.details["output_ref"]
    assert receipt["receipt_path"] == error.details["receipt_path"]
    assert receipt["error"]["code"] == error.code
    assert receipt["state_source"] == "last_persisted_receipt"
    assert not receipt.get("structure_verified") and not receipt.get("source_preserved")
    assert receipt["ui_opened"] is False and receipt["render_verified"] is False
    listed = lab.adapter.list_operations()["operations"]
    assert (
        next(item for item in listed if item["operation_id"] == receipt["operation_id"])["status"] == "failed"
    )
    _assert_source_preserved(lab)
    return receipt


def _edit(lab, operation):
    if operation == "remove":
        return remove_clip(lab.adapter, SOURCE_REF, "selected")
    if operation == "speed":
        return set_speed(lab.adapter, SOURCE_REF, "selected", speed=3)
    assert operation == "subtitles"
    return add_subtitles(lab.adapter, SOURCE_REF, [{"start": 13, "duration": 1, "text": "新增字幕"}])


def _assert_no_copy(lab):
    assert lab.cli.calls == []
    assert list(lab.root.iterdir()) == [lab.source]
    assert lab.adapter.list_operations()["operations"] == []


@pytest.mark.parametrize("ripple", [False, True])
def test_remove_ripple_only_moves_same_track_and_preserves_source(native_edits, ripple):
    lab = native_edits
    result = remove_clip(lab.adapter, SOURCE_REF, "selected", ripple, digest(lab.path))
    after = _assert_success(lab, result, 3 if ripple else 1)
    expected = copy.deepcopy(lab.original["tracks"])
    expected[0]["segments"].pop(1)
    if ripple:
        for item in expected[0]["segments"][1:]:
            item["target_timerange"]["start"] -= 3_000_000
    assert after["tracks"] == expected  # Cross-track video, audio, existing text and source ranges are exact.
    assert result["removed_segment_id"] == "selected"
    assert after["duration"] == result["duration_us"] == (9_000_000 if ripple else 12_000_000)
    assert result["shifted_segments"] == (
        [{"segment_id": "later-1", "start_us": 3_000_000}, {"segment_id": "later-2", "start_us": 7_000_000}]
        if ripple
        else []
    )
    assert lab.cli.calls[1] == [
        "draft",
        "segment",
        "remove",
        "--seg-id",
        "selected",
        "--ref",
        result["output_ref"],
    ]
    if ripple:
        assert lab.cli.calls[2:] == [
            [
                "draft",
                "segment",
                "move",
                "--seg-id",
                segment_id,
                "--start",
                f"{start}us",
                "--ref",
                result["output_ref"],
            ]
            for segment_id, start in [("later-1", 3_000_000), ("later-2", 7_000_000)]
        ]


@pytest.mark.parametrize("prune", [False, True])
def test_removing_only_segment_accepts_retained_or_pruned_empty_track(native_edits, prune):
    lab = native_edits
    lab.cli.prune_empty_track = prune
    result = remove_clip(lab.adapter, SOURCE_REF, "old-subtitle", ripple=True)
    after = _assert_success(lab, result)
    assert result["shifted_segments"] == []
    assert after["tracks"][:3] == lab.original["tracks"][:3]
    assert [track["id"] for track in after["tracks"]] == (
        ["main-video", "other-video", "audio-track"]
        if prune
        else ["main-video", "other-video", "audio-track", "existing-text"]
    )


@pytest.mark.parametrize(
    "segment_id,speed",
    [
        ("selected", 3),
        ("selected", 2.5),
        ("selected", 100),
        ("later-2", 3),
        ("later-2", 0.01),
    ],
)
def test_constant_speed_exact_cli_units_material_and_clip_readback(native_edits, segment_id, speed):
    lab = native_edits
    original = _segment(lab.original, segment_id)[1]
    result = set_speed(
        lab.adapter, SOURCE_REF, segment_id, speed=speed, expected_content_sha256=digest(lab.path)
    )
    after = _assert_success(lab, result)
    inspected = lab.adapter.inspect_clip(result["output_ref"], segment_id)
    updated = inspected["segment"]
    expected_duration = round(original["source_timerange"]["duration"] / speed)
    assert updated["source_timerange"] == original["source_timerange"] == result["source_timerange_us"]
    assert (
        updated["target_timerange"]
        == result["target_timerange_us"]
        == {
            "start": original["target_timerange"]["start"],
            "duration": expected_duration,
        }
    )
    assert updated["speed"] == result["speed_material"]["speed"] == speed
    assert result["speed_material"]["curve_speed"] is None
    assert inspected["missing_material_ids"] == []
    assert inspected["content_sha256"] == result["output_sha256"]
    assert inspected["state_source"] == "last_saved_main_timeline"
    assert inspected["time_unit"] == "integer_microseconds"
    assert result["speed_material"] in [
        entry["material"] for entry in inspected["materials"] if entry["category"] == "speeds"
    ]
    assert lab.cli.calls[1] == [
        "draft",
        "video",
        "speed",
        "--seg-id",
        segment_id,
        "--speed",
        str(speed),
        "--ref",
        result["output_ref"],
    ]
    expected_tracks = copy.deepcopy(lab.original["tracks"])
    _segment({"tracks": expected_tracks}, segment_id)[1].update(updated)
    assert after["tracks"] == expected_tracks
    expected_end = 10_000_000 + expected_duration if segment_id == "later-2" else 12_000_000
    assert after["duration"] == result["duration_us"] == expected_end


@pytest.mark.parametrize("name", ["Hero", "Montage", "Bullet", "JumpCut", "FlashIn", "FlashOut"])
def test_preset_curve_parameter_and_saved_material_readback(native_edits, name):
    lab = native_edits
    result = set_speed(lab.adapter, SOURCE_REF, "selected", curve_name=name)
    _assert_success(lab, result)
    assert lab.cli.calls[1] == [
        "draft",
        "video",
        "speed",
        "--seg-id",
        "selected",
        "--curve-name",
        name,
        "--ref",
        result["output_ref"],
    ]
    assert result["curve_name"] == name and result["requested_speed"] is None
    assert result["speed_material"]["mode"] == 1
    assert result["speed_material"]["curve_speed"]["name"] == name
    assert result["speed_material"]["curve_speed"]["speed_points"]
    inspected = lab.adapter.inspect_clip(result["output_ref"], "selected")
    assert result["speed_material"] in [entry["material"] for entry in inspected["materials"]]
    assert inspected["segment"]["source_timerange"] == {"start": 10_000_000, "duration": 6_000_000}
    assert inspected["segment"]["target_timerange"] == {"start": 2_000_000, "duration": 2_000_000}


@pytest.mark.parametrize(
    "points",
    [
        CURVE_POINTS,
        [CurvePoint(x=0, y=2), CurvePoint(x=1, y=4)],
        [{"x": index / 49, "y": 3} for index in range(50)],
    ],
)
def test_custom_curve_json_and_saved_points_are_read_back(native_edits, points):
    lab = native_edits
    expected = [CurvePoint.model_validate(point).model_dump() for point in points]
    result = set_speed(lab.adapter, SOURCE_REF, "selected", curve_points=points)
    _assert_success(lab, result)
    command = lab.cli.calls[1]
    encoded = command[command.index("--curve-points") + 1]
    assert encoded == json.dumps(expected, separators=(",", ":"))
    assert "--curve-name" not in command and "--speed" not in command
    assert result["curve_points"] == expected
    assert result["speed_material"]["curve_speed"]["speed_points"] == expected
    inspected = lab.adapter.inspect_clip(result["output_ref"], "selected")
    assert inspected["segment"]["target_timerange"] == {"start": 2_000_000, "duration": 2_000_000}
    assert result["speed_material"] in [entry["material"] for entry in inspected["materials"]]


def test_batch_subtitles_normalize_sort_and_read_back_text_and_microseconds(native_edits):
    lab = native_edits
    cues = [
        {"start": 13.000001, "duration": 0.999999, "text": "末句，保留空格  "},
        SubtitleCue(start=1.000001, duration=0.333333, text='第一句\r\n"Second"\r第三行'),
        {"start": 1.333334, "duration": 0.666666, "text": "紧邻字幕：--ref local://文本，不是参数"},
    ]
    result = add_subtitles(lab.adapter, SOURCE_REF, cues, digest(lab.path))
    after = _assert_success(lab, result, 3)
    expected = [
        (1_000_001, 333_333, '第一句\n"Second"\n第三行'),
        (1_333_334, 666_666, "紧邻字幕：--ref local://文本，不是参数"),
        (13_000_001, 999_999, "末句，保留空格  "),
    ]
    assert result["cue_count"] == 3 and result["duration_us"] == after["duration"] == 14_000_000
    assert after["tracks"][:4] == lab.original["tracks"]
    for command, added, (start, duration, text) in zip(lab.cli.calls[1:], result["segments"], expected):
        assert command == [
            "draft",
            "subtitle",
            "add",
            "--content",
            text,
            "--start",
            f"{start}us",
            "--duration",
            f"{duration}us",
            "--ref",
            result["output_ref"],
        ]
        inspected = lab.adapter.inspect_clip(result["output_ref"], added["segment_id"])
        assert added["track_id"] == inspected["track_id"] == "added-subtitles"
        assert inspected["track_type"] == "text" and inspected["missing_material_ids"] == []
        assert (
            added["target_timerange_us"]
            == inspected["segment"]["target_timerange"]
            == {"start": start, "duration": duration}
        )
        text_material = inspected["materials"][0]
        assert text_material["category"] == "texts"
        assert json.loads(text_material["material"]["content"])["text"] == added["text"] == text
    page = lab.adapter.inspect(result["output_ref"], offset=8, limit=1)
    assert page["segment_count"] == 10 and page["next_offset"] == 9
    assert page["segments"][0]["segment_id"] == result["segments"][1]["segment_id"]


def test_chained_edits_duplicate_the_requested_ref_not_the_initial_source(native_edits):
    lab = native_edits
    first = remove_clip(lab.adapter, SOURCE_REF, "selected", ripple=True)
    first_files = _snapshot(lab.adapter.directory(first["output_ref"]))
    second = add_subtitles(
        lab.adapter, first["output_ref"], [{"start": 9, "duration": 1, "text": "链式字幕"}]
    )
    second_files = _snapshot(lab.adapter.directory(second["output_ref"]))
    third = set_speed(lab.adapter, second["output_ref"], "later-2", speed=2)
    after = _assert_success(lab, third)
    duplicates = [call for call in lab.cli.calls if call[:3] == ["draft", "project", "duplicate"]]
    assert [SimulatedNativeCLI.option(call, "--ref") for call in duplicates] == [
        SOURCE_REF,
        first["output_ref"],
        second["output_ref"],
    ]
    assert len({first["output_ref"], second["output_ref"], third["output_ref"]}) == 3
    assert not any(item["id"] == "selected" for track in after["tracks"] for item in track["segments"])
    assert _segment(after, "later-1")[1]["target_timerange"]["start"] == 3_000_000
    assert _segment(after, "later-2")[1]["target_timerange"] == {"start": 7_000_000, "duration": 1_000_000}
    assert (
        lab.adapter.inspect_clip(third["output_ref"], second["segments"][0]["segment_id"])["track_type"]
        == "text"
    )
    assert _snapshot(lab.adapter.directory(first["output_ref"])) == first_files
    assert _snapshot(lab.adapter.directory(second["output_ref"])) == second_files


@pytest.mark.parametrize(
    "kwargs",
    [
        {},
        {"speed": 2, "curve_name": "Hero"},
        {"speed": 2, "curve_points": CURVE_POINTS},
        {"curve_name": "Hero", "curve_points": CURVE_POINTS},
        *[
            {"speed": speed}
            for speed in [True, False, 0, -1, 0.009, 100.001, float("nan"), float("inf"), -float("inf")]
        ],
        {"curve_name": "hero"},
        {"curve_name": "unsupported"},
        *[
            {"curve_points": points}
            for points in [
                [],
                [{"x": 0, "y": 1}],
                [{"x": index / 50, "y": 1} for index in range(51)],
                [{"x": 0.1, "y": 1}, {"x": 1, "y": 1}],
                [{"x": 0, "y": 1}, {"x": 0.9, "y": 1}],
                [{"x": 0, "y": 1}, {"x": 0, "y": 2}, {"x": 1, "y": 1}],
                [{"x": 0, "y": 1}, {"x": 0.8, "y": 2}, {"x": 0.2, "y": 2}, {"x": 1, "y": 1}],
                [{"x": -0.1, "y": 1}, {"x": 1, "y": 1}],
                [{"x": 0, "y": 0}, {"x": 1, "y": 1}],
                [{"x": 0, "y": 101}, {"x": 1, "y": 1}],
                [{"x": float("nan"), "y": 1}, {"x": 1, "y": 1}],
                [{"x": 0, "y": float("inf")}, {"x": 1, "y": 1}],
                [{"x": 0, "y": 1, "extra": 1}, {"x": 1, "y": 1}],
            ]
        ],
    ],
)
def test_invalid_speed_arguments_are_rejected_before_duplicate(native_edits, kwargs):
    lab = native_edits
    with pytest.raises((EditError, ValidationError)):
        set_speed(lab.adapter, SOURCE_REF, "selected", **kwargs)
    _assert_no_copy(lab)
    _assert_source_preserved(lab)


@pytest.mark.parametrize(
    "cues",
    [
        [],
        [{"start": index, "duration": 1, "text": "x"} for index in range(201)],
        *[
            [{"start": 0, "duration": 1, "text": "valid", **patch}]
            for patch in [
                {"start": -1},
                {"start": float("nan")},
                {"start": float("inf")},
                {"duration": 0},
                {"duration": -1},
                {"duration": float("nan")},
                {"duration": float("inf")},
                {"duration": 0.0000001},
                {"text": ""},
                {"text": " \t\r\n"},
                {"text": "x\0y"},
                {"text": "x" * 10001},
                {"extra": "unexpected"},
            ]
        ],
        [{"start": 0, "duration": 1}],
        [{"start": 1, "duration": 1, "text": "later"}, {"start": 0, "duration": 1.000001, "text": "earlier"}],
    ],
)
def test_invalid_subtitles_are_rejected_before_duplicate(native_edits, cues):
    lab = native_edits
    with pytest.raises((EditError, ValidationError)):
        add_subtitles(lab.adapter, SOURCE_REF, cues)
    _assert_no_copy(lab)
    _assert_source_preserved(lab)


@pytest.mark.parametrize("operation", ["remove", "speed", "subtitles"])
def test_revision_conflict_is_rejected_before_duplicate(native_edits, operation):
    lab = native_edits
    with pytest.raises(EditError) as caught:
        if operation == "remove":
            remove_clip(lab.adapter, SOURCE_REF, "selected", expected_content_sha256="0" * 64)
        elif operation == "speed":
            set_speed(lab.adapter, SOURCE_REF, "selected", speed=3, expected_content_sha256="0" * 64)
        else:
            add_subtitles(lab.adapter, SOURCE_REF, [{"start": 0, "duration": 1, "text": "x"}], "0" * 64)
    assert caught.value.code == "NATIVE_REVISION_CONFLICT"
    assert caught.value.details["actual_sha256"] == digest(lab.path)
    _assert_no_copy(lab)


@pytest.mark.parametrize("segment_id", ["missing", "../selected", ""])
@pytest.mark.parametrize("operation", ["remove", "speed"])
def test_invalid_segment_is_rejected_before_duplicate(native_edits, segment_id, operation):
    lab = native_edits
    with pytest.raises(EditError):
        if operation == "remove":
            remove_clip(lab.adapter, SOURCE_REF, segment_id)
        else:
            set_speed(lab.adapter, SOURCE_REF, segment_id, speed=3)
    _assert_no_copy(lab)


@pytest.mark.parametrize(
    "case,expected_code",
    [
        ("audio", "NATIVE_VIDEO_REQUIRED"),
        ("no-source", "NATIVE_VIDEO_REQUIRED"),
        ("overlap", "NATIVE_SPEED_OVERLAP"),
        ("rounds-zero", "NATIVE_SPEED_OVERLAP"),
    ],
)
def test_speed_preflight_rejects_unsupported_or_impossible_ranges(native_edits, case, expected_code):
    lab = native_edits
    segment_id, speed = "selected", 3
    if case == "audio":
        segment_id = "audio-clip"
    elif case == "overlap":
        speed = 1
    else:
        content = read_json(lab.path)
        segment = _segment(content, segment_id)[1]
        if case == "no-source":
            segment.pop("source_timerange")
        else:
            segment["source_timerange"]["duration"] = 1
            speed = 100
        write_json(lab.path, content)
    fingerprint = digest(lab.path)
    with pytest.raises(EditError) as caught:
        set_speed(lab.adapter, SOURCE_REF, segment_id, speed=speed)
    assert caught.value.code == expected_code
    assert digest(lab.path) == fingerprint
    _assert_no_copy(lab)


@pytest.mark.parametrize("operation", ["remove", "speed", "subtitles"])
def test_overlapping_native_input_is_rejected_before_duplicate(native_edits, operation):
    lab = native_edits
    content = read_json(lab.path)
    _segment(content, "later-1")[1]["target_timerange"]["start"] = 4_000_000
    write_json(lab.path, content)
    with pytest.raises(EditError) as caught:
        _edit(lab, operation)
    assert caught.value.code == "NATIVE_TRACK_OVERLAP"
    _assert_no_copy(lab)


@pytest.mark.parametrize("operation", ["remove", "subtitles"])
def test_second_command_failure_keeps_native_error_and_queryable_progress(native_edits, operation):
    lab = native_edits
    lab.cli.fail_at = 2
    with pytest.raises(EditError) as caught:
        if operation == "remove":
            remove_clip(lab.adapter, SOURCE_REF, "selected", ripple=True)
        else:
            add_subtitles(
                lab.adapter,
                SOURCE_REF,
                [{"start": index, "duration": 1, "text": f"字幕{index}"} for index in range(3)],
            )
    error = caught.value
    assert error.code == "LYRA_OPERATION_FAILED" and error.details["native_error_code"] == -100110
    receipt = _assert_failed(lab, error, completed=1, command_count=3, stage="mutating")
    assert receipt["error"]["native_error_code"] == -100110
    assert receipt["error"]["native_category"] == "operation"
    assert receipt["error"]["recovery"] == "inspect the saved copy before retrying"
    assert len(receipt["affected_segments"]) == 1
    assert len(lab.cli.calls) == 3  # duplicate, one completed mutation, then the failed command; no replay.
    assert [(item["status"], item["stage"], item["completed_commands"]) for item in lab.cli.progress] == [
        ("started", "duplicating", 0),
        ("started", "mutating", 0),
        ("started", "mutating", 1),
    ]
    assert all(item["command_count"] == 3 for item in lab.cli.progress)
    partial = lab.adapter.read(receipt["output_ref"])["content"]
    if operation == "remove":
        assert not any(item["id"] == "selected" for track in partial["tracks"] for item in track["segments"])
        assert _segment(partial, "later-1")[1]["target_timerange"]["start"] == 6_000_000
    else:
        assert (
            len(next(track for track in partial["tracks"] if track["id"] == "added-subtitles")["segments"])
            == 1
        )


@pytest.mark.parametrize("operation", ["remove", "speed", "subtitles"])
def test_native_success_without_a_saved_edit_is_rejected(native_edits, operation):
    lab = native_edits
    lab.cli.skip_mutation = True
    with pytest.raises(EditError) as caught:
        _edit(lab, operation)
    assert caught.value.code == "NATIVE_EDIT_VERIFICATION_FAILED"
    receipt = _assert_failed(lab, caught.value)
    assert receipt["affected_segments"]  # The native success envelope is deliberately misleading.
    assert lab.adapter.read(receipt["output_ref"])["content"] == lab.original


@pytest.mark.parametrize("fault", ["text", "time", "track-type", "missing-cue"])
def test_wrong_saved_subtitle_is_rejected_despite_success(native_edits, fault):
    lab = native_edits

    def corrupt(content):
        track = next(track for track in content["tracks"] if track["id"] == "added-subtitles")
        segment = track["segments"][0]
        if fault == "text":
            _material(content, segment["material_id"])["content"] = json.dumps({"text": "错误字幕"})
        elif fault == "time":
            segment["target_timerange"]["start"] -= 1
        elif fault == "track-type":
            track["type"] = "video"
        else:
            track["segments"] = []

    lab.cli.corrupt = corrupt
    with pytest.raises(EditError) as caught:
        _edit(lab, "subtitles")
    assert caught.value.code == "NATIVE_EDIT_VERIFICATION_FAILED"
    _assert_failed(lab, caught.value)


@pytest.mark.parametrize(
    "fault",
    [
        "segment-speed",
        "material-speed",
        "retained-curve",
        "duration",
        "source-range",
        "position",
        "effect-ref",
        "effect-material",
        "preset-name",
        "custom-points",
        "curve-mode",
        "empty-curve",
    ],
)
def test_incorrect_speed_saved_state_is_rejected(native_edits, fault):
    lab = native_edits

    def corrupt(content):
        segment = _segment(content, "selected")[1]
        speed_material = _material(content, segment["extra_material_refs"][-1])
        if fault == "segment-speed":
            segment["speed"] = 4
        elif fault == "material-speed":
            speed_material["speed"] = 4
        elif fault == "retained-curve":
            speed_material["curve_speed"] = {"name": "Hero", "speed_points": CURVE_POINTS}
        elif fault == "duration":
            segment["target_timerange"]["duration"] += 2
        elif fault == "source-range":
            segment["source_timerange"]["start"] += 1
        elif fault == "position":
            segment["target_timerange"]["start"] += 1
        elif fault == "effect-ref":
            segment["extra_material_refs"].remove("effect-selected")
        elif fault == "effect-material":
            _material(content, "effect-selected")["value"] += 1
        elif fault == "preset-name":
            speed_material["curve_speed"]["name"] = "Bullet"
        elif fault == "custom-points":
            speed_material["curve_speed"]["speed_points"][1]["y"] += 0.1
        elif fault == "curve-mode":
            speed_material["mode"] = 0
        else:
            speed_material["curve_speed"]["speed_points"] = []

    lab.cli.corrupt = corrupt
    kwargs = {"speed": 3}
    if fault in {"preset-name", "curve-mode", "empty-curve"}:
        kwargs = {"curve_name": "Hero"}
    elif fault == "custom-points":
        kwargs = {"curve_points": CURVE_POINTS}
    with pytest.raises(EditError) as caught:
        set_speed(lab.adapter, SOURCE_REF, "selected", **kwargs)
    assert caught.value.code == "NATIVE_EDIT_VERIFICATION_FAILED"
    _assert_failed(lab, caught.value)


@pytest.mark.parametrize("operation", ["remove", "speed", "subtitles"])
@pytest.mark.parametrize(
    "fault", ["same-track-segment", "cross-track-segment", "track", "duration", "canvas"]
)
def test_success_that_changes_unselected_timeline_or_project_state_is_rejected(
    native_edits, operation, fault
):
    lab = native_edits

    def corrupt(content):
        if fault == "same-track-segment":
            _segment(content, "later-1")[1]["volume"] = 0.5
        elif fault == "cross-track-segment":
            _segment(content, "cross-track")[1]["target_timerange"]["start"] += 1
        elif fault == "track":
            content["tracks"][0]["name"] = "被意外修改"
        elif fault == "duration":
            content["duration"] += 1
        else:
            content["canvas_config"]["width"] = 640

    lab.cli.corrupt = corrupt
    with pytest.raises(EditError) as caught:
        _edit(lab, operation)
    assert caught.value.code == "NATIVE_EDIT_VERIFICATION_FAILED"
    _assert_failed(lab, caught.value)


@pytest.mark.parametrize("operation", ["remove", "speed", "subtitles"])
@pytest.mark.parametrize(
    "fault", ["shared-video", "effect", "speed", "existing-text", "deleted-ref", "category"]
)
def test_material_content_and_extra_refs_are_protected_not_just_cli_replies(native_edits, operation, fault):
    lab = native_edits

    def corrupt(content):
        if fault == "shared-video":
            _material(content, "video-shared")["path"] = "wrong-source.mp4"
        elif fault == "effect":
            _material(content, "effect-shared")["value"] += 1
        elif fault == "speed":
            _material(content, "speed-shared")["speed"] = 7
        elif fault == "existing-text":
            _material(content, "text-existing")["content"] = json.dumps({"text": "原字幕被篡改"})
        else:
            item = _material(content, "effect-shared")
            content["materials"]["effects"].remove(item)
            if fault == "category":
                content["materials"]["stickers"] = [item]

    lab.cli.corrupt = corrupt
    with pytest.raises(EditError) as caught:
        _edit(lab, operation)
    assert caught.value.code == "NATIVE_EDIT_VERIFICATION_FAILED"
    assert "material" in str(caught.value).lower()
    _assert_failed(lab, caught.value)


def test_inspect_clip_reports_only_referenced_materials_and_missing_ids(native_edits):
    lab = native_edits
    content = read_json(lab.path)
    _segment(content, "selected")[1]["extra_material_refs"].append("missing-effect")
    write_json(lab.path, content)
    result = lab.adapter.inspect_clip(SOURCE_REF, "selected")
    assert result["segment"] == _segment(content, "selected")[1]
    assert result["track_id"] == "main-video" and result["track_type"] == "video"
    assert {(item["category"], item["material"]["id"]) for item in result["materials"]} == {
        ("videos", "video-shared"),
        ("speeds", "speed-selected"),
        ("effects", "effect-selected"),
    }
    assert result["missing_material_ids"] == ["missing-effect"]
    assert result["content_sha256"] == digest(lab.path)
    assert lab.cli.calls == []


def test_receipts_are_queryable_paginated_and_ordered_with_failures(native_edits):
    lab = native_edits
    results = [_edit(lab, operation) for operation in ["remove", "speed", "subtitles"]]
    lab.cli.fail_at = lab.cli.mutation_count + 1
    with pytest.raises(EditError) as caught:
        _edit(lab, "speed")
    failure = _assert_failed(lab, caught.value, completed=0, stage="mutating")
    results.append(failure)
    for index, result in enumerate(results):
        timestamp = 1_700_000_000_000_000_000 + index * 1_000_000_000
        os.utime(result["receipt_path"], ns=(timestamp, timestamp))
    adapter = NativeDrafts(lab.adapter.editor)
    first = adapter.list_operations(offset=0, limit=2)
    second = adapter.list_operations(offset=first["next_offset"], limit=2)
    assert first["next_offset"] == 2 and second["next_offset"] is None
    entries = first["operations"] + second["operations"]
    assert [item["operation_id"] for item in entries] == [item["operation_id"] for item in reversed(results)]
    assert [item["status"] for item in entries] == ["failed", "succeeded", "succeeded", "succeeded"]
    assert entries[0]["error"]["native_error_code"] == -100110
    assert entries[0]["completed_commands"] == 0 and entries[0]["command_count"] == 1
    assert first["state_source"] == second["state_source"] == "last_persisted_receipts"
    assert "not proof" in first["guidance"]
    assert adapter.list_operations(offset=4, limit=2)["operations"] == []
    assert adapter.list_operations(offset=99, limit=2)["next_offset"] is None
    for item in entries:
        receipt = adapter.operation(item["operation_id"])
        assert receipt["state_source"] == "last_persisted_receipt"
        assert receipt["source_ref"] == item["source_ref"] == SOURCE_REF
        assert "segments" not in item and "affected_segments" not in item
    _assert_source_preserved(lab)


def test_operation_lookup_rejects_unknown_and_path_like_ids_without_cli(native_edits):
    lab = native_edits
    with pytest.raises(EditError) as caught:
        lab.adapter.operation("0" * 32)
    assert caught.value.code == "NATIVE_OPERATION_NOT_FOUND"
    for operation_id in ["../outside", "0" * 31, "g" * 32, "", "A" * 32]:
        with pytest.raises(EditError) as caught:
            lab.adapter.operation(operation_id)
        assert caught.value.code == "INVALID_ID"
    _assert_no_copy(lab)
