"""Bounded native edits with copy-on-write and saved-content verification."""

from __future__ import annotations

import json
import math
from copy import deepcopy
from itertools import pairwise
from typing import Literal

from pydantic import Field

from .core import EditError, Model, Positive, Seconds, us

CurveName = Literal["Hero", "Montage", "Bullet", "JumpCut", "FlashIn", "FlashOut"]


class CurvePoint(Model):
    x: float = Field(ge=0, le=1)
    y: float = Field(ge=0.01, le=100)


class SubtitleCue(Model):
    start: Seconds
    duration: Positive
    text: str = Field(min_length=1, max_length=10000)


def require(condition, message):
    if not condition:
        raise EditError("NATIVE_EDIT_VERIFICATION_FAILED", message)


def materials(content):
    result = {}
    for category, group in content.get("materials", {}).items():
        if not isinstance(group, list):
            continue
        for item in group:
            if isinstance(item, dict) and item.get("id"):
                require(item["id"] not in result, "Native material IDs are not unique.")
                result[item["id"]] = (category, item)
    return result


def segments(content):
    return [segment for track in content["tracks"] for segment in track.get("segments", [])]


def normalize_ranges(content):
    content = deepcopy(content)
    # Native protobuf JSON omits empty segment lists and zero range starts.
    for track in content["tracks"]:
        track.setdefault("segments", [])
    for segment in segments(content):
        for field in ["source_timerange", "target_timerange"]:
            if isinstance(segment.get(field), dict):
                segment[field].setdefault("start", 0)
    return content


def comparable_edit(before, after, moved_ids):
    after = normalize_ranges(after)
    old, new = materials(before), materials(after)
    # Moving a segment can allocate an empty animation placeholder with no animation payload.
    empty = {
        rid
        for rid, (category, value) in new.items()
        if rid not in old
        and category == "material_animations"
        and value == {"id": rid, "type": "sticker_animation"}
    }
    for item in segments(after):
        if item["id"] in moved_ids and "extra_material_refs" in item:
            item["extra_material_refs"] = [rid for rid in item["extra_material_refs"] if rid not in empty]
    return after


def check_tracks(content):
    ids = [track["id"] for track in content["tracks"]] + [s["id"] for s in segments(content)]
    if len(ids) != len(set(ids)):
        raise EditError("INVALID_NATIVE_DRAFT", "Native track and segment IDs must be unique.")
    for track in content["tracks"]:
        end = 0
        for segment in sorted(track.get("segments", []), key=lambda s: s["target_timerange"]["start"]):
            interval = segment["target_timerange"]
            start, duration = interval["start"], interval["duration"]
            if any(type(value) is not int for value in [start, duration]) or start < end or duration <= 0:
                raise EditError(
                    "NATIVE_TRACK_OVERLAP",
                    "Native edits require positive, non-overlapping same-track ranges.",
                )
            end = start + duration


def check_duration(content):
    duration = max(
        (s["target_timerange"]["start"] + s["target_timerange"]["duration"] for s in segments(content)),
        default=0,
    )
    require(content.get("duration") == duration, "Saved project duration does not match the timeline end.")


def preserve_materials(before, after, selected_ids=()):
    old, new = materials(before), materials(after)
    protected = {
        ref
        for segment in segments(before)
        if segment["id"] not in selected_ids
        for ref in [segment.get("material_id"), *segment.get("extra_material_refs", [])]
        if ref
    }
    for ref in protected:
        require(
            ref in old and new.get(ref) == old[ref],
            "An unselected segment's material changed or disappeared.",
        )


def remove_clip(adapter, ref, seg_id, ripple=False, expected_content_sha256=None):
    restore_positions = []

    def prepare(before):
        before = normalize_ranges(before)
        check_tracks(before)
        track, segment = adapter.segment(before, seg_id)
        interval = segment["target_timerange"]
        end = interval["start"] + interval["duration"]
        expected = deepcopy(before)
        expected_track, removed = adapter.segment(expected, seg_id)
        expected_track["segments"].remove(removed)
        commands = [["draft", "segment", "remove", "--seg-id", seg_id]]
        shifted = []
        if ripple:
            for item in sorted(expected_track["segments"], key=lambda s: s["target_timerange"]["start"]):
                if item["target_timerange"]["start"] >= end:
                    item["target_timerange"]["start"] -= interval["duration"]
                    start = item["target_timerange"]["start"]
                    commands.append(
                        ["draft", "segment", "move", "--seg-id", item["id"], "--start", f"{start}us"]
                    )
                    shifted.append({"segment_id": item["id"], "start_us": start})

        starts = {item["id"]: item["target_timerange"]["start"] for item in segments(before)}
        restore_positions.extend(
            (item["id"], item["target_timerange"]["start"], interval["duration"])
            for item in segments(expected)
            if starts[item["id"]] >= end
        )

        def verify(after):
            after = comparable_edit(before, after, {item[0] for item in restore_positions})
            expected_tracks = expected["tracks"]
            if not expected_track["segments"] and not any(t["id"] == track["id"] for t in after["tracks"]):
                expected_tracks = [t for t in expected_tracks if t["id"] != track["id"]]
            require(
                after["tracks"] == expected_tracks,
                "Removal changed more than the selected segment and requested same-track positions.",
            )
            preserve_materials(before, after, {seg_id})
            check_duration(after)
            return {
                "removed_segment_id": seg_id,
                "shifted_segments": shifted,
                "duration_us": after["duration"],
            }

        return commands, verify, {"segment_id": seg_id, "ripple": ripple, "track_id": track["id"]}

    def reconcile(after):
        current = {item["id"]: item["target_timerange"].get("start", 0) for item in segments(after)}
        # Vendor main-track removal can implicitly ripple linked tracks. Restore only that exact shift.
        return [
            ["draft", "segment", "move", "--seg-id", segment_id, "--start", f"{start}us"]
            for segment_id, start, duration in restore_positions
            if current.get(segment_id) == start - duration
        ]

    return adapter.edit_copy(ref, "remove", prepare, expected_content_sha256, reconcile=reconcile)


def set_speed(
    adapter, ref, seg_id, speed=None, curve_name=None, curve_points=None, expected_content_sha256=None
):
    if sum(value is not None for value in [speed, curve_name, curve_points]) != 1:
        raise EditError("INVALID_SPEED_MODE", "Choose exactly one of speed, curve_name or curve_points.")
    if speed is not None and (
        isinstance(speed, bool) or not math.isfinite(speed) or not 0.01 <= speed <= 100
    ):
        raise EditError("INVALID_SPEED", "Constant speed must be finite and between 0.01 and 100.")
    if curve_name is not None and curve_name not in {
        "Hero",
        "Montage",
        "Bullet",
        "JumpCut",
        "FlashIn",
        "FlashOut",
    }:
        raise EditError("INVALID_SPEED_CURVE", "Use a supported native curve name.")
    points = None
    if curve_points is not None:
        points = [CurvePoint.model_validate(point).model_dump() for point in curve_points]
        if (
            not 2 <= len(points) <= 50
            or points[0]["x"] != 0
            or points[-1]["x"] != 1
            or any(left["x"] >= right["x"] for left, right in pairwise(points))
        ):
            raise EditError(
                "INVALID_SPEED_CURVE",
                "Supply 2..50 ordered points spanning x=0 to x=1, with strictly increasing x.",
            )

    def prepare(before):
        before = normalize_ranges(before)
        check_tracks(before)
        track, segment = adapter.segment(before, seg_id)
        if track["type"] != "video" or not segment.get("source_timerange"):
            raise EditError("NATIVE_VIDEO_REQUIRED", "Native speed requires a timed video segment.")
        source = segment["source_timerange"]
        target = segment["target_timerange"]
        if speed is not None:
            duration = round(source["duration"] / speed)
            if duration < 1 or any(
                other["id"] != seg_id
                and other["target_timerange"]["start"] >= target["start"]
                and other["target_timerange"]["start"] < target["start"] + duration
                for other in track["segments"]
            ):
                raise EditError(
                    "NATIVE_SPEED_OVERLAP",
                    "The requested speed would overlap the next segment or round to zero duration.",
                )
        command = ["draft", "video", "speed", "--seg-id", seg_id]
        if speed is not None:
            command += ["--speed", str(speed)]
        elif curve_name is not None:
            command += ["--curve-name", curve_name]
        else:
            command += ["--curve-points", json.dumps(points, separators=(",", ":"))]

        def verify(after):
            after = comparable_edit(before, after, {seg_id})
            check_tracks(after)
            _, updated = adapter.segment(after, seg_id)
            require(updated.get("source_timerange") == source, "Speed edit unexpectedly trimmed the source.")
            require(
                updated["target_timerange"]["start"] == target["start"],
                "Speed edit moved the selected segment.",
            )
            old_materials, new_materials = materials(before), materials(after)
            old_media = old_materials.get(segment.get("material_id"))
            new_media = new_materials.get(updated.get("material_id"))
            require(old_media is not None and new_media is not None, "Speed edit lost the source material.")
            require(
                old_media[0] == new_media[0]
                and {k: v for k, v in old_media[1].items() if k != "id"}
                == {k: v for k, v in new_media[1].items() if k != "id"},
                "Speed edit changed the source material.",
            )

            def other_refs(item, index):
                return [
                    rid
                    for rid in item.get("extra_material_refs", [])
                    if index.get(rid, (None,))[0] != "speeds"
                ]

            require(
                other_refs(segment, old_materials) == other_refs(updated, new_materials),
                "Speed edit changed unrelated effect references.",
            )
            for rid in other_refs(segment, old_materials):
                require(
                    rid in old_materials and new_materials.get(rid) == old_materials[rid],
                    "Speed edit changed an unrelated effect material.",
                )
            speed_materials = [
                new_materials[rid][1]
                for rid in updated.get("extra_material_refs", [])
                if new_materials.get(rid, (None,))[0] == "speeds"
            ]
            require(len(speed_materials) == 1, "Expected exactly one referenced speed material.")
            saved_speed = speed_materials[0]
            if speed is not None:
                require(
                    math.isclose(updated.get("speed", 0), speed, rel_tol=1e-6)
                    and math.isclose(saved_speed.get("speed", 0), speed, rel_tol=1e-6),
                    "Saved constant speed differs from the request.",
                )
                require(not saved_speed.get("curve_speed"), "Constant speed unexpectedly retained a curve.")
                require(
                    abs(updated["target_timerange"]["duration"] - round(source["duration"] / speed)) <= 1,
                    "Saved duration differs from the requested constant speed.",
                )
            else:
                curve = saved_speed.get("curve_speed") or {}
                require(
                    saved_speed.get("mode") == 1 and bool(curve.get("speed_points")),
                    "Native curve speed was not saved.",
                )
                if curve_name is not None:
                    require(curve.get("name") == curve_name, "Saved curve preset differs from the request.")
                else:
                    saved_points = curve["speed_points"]
                    require(
                        len(saved_points) == len(points)
                        and all(
                            math.isclose(actual.get(key, -1), wanted[key], abs_tol=1e-6)
                            for actual, wanted in zip(saved_points, points)
                            for key in ["x", "y"]
                        ),
                        "Saved curve points differ from the request.",
                    )
            expected = deepcopy(before)
            _, expected_segment = adapter.segment(expected, seg_id)
            for field in ["speed", "target_timerange", "material_id", "extra_material_refs"]:
                if field in updated:
                    expected_segment[field] = deepcopy(updated[field])
                else:
                    expected_segment.pop(field, None)
            require(
                expected["tracks"] == after["tracks"], "Speed edit changed unrelated segment or track data."
            )
            preserve_materials(before, after, {seg_id})
            check_duration(after)
            return {
                "segment_id": seg_id,
                "source_timerange_us": updated["source_timerange"],
                "target_timerange_us": updated["target_timerange"],
                "speed_material": saved_speed,
                "duration_us": after["duration"],
            }

        return (
            [command],
            verify,
            {
                "segment_id": seg_id,
                "requested_speed": speed,
                "curve_name": curve_name,
                "curve_points": points,
            },
        )

    return adapter.edit_copy(ref, "speed", prepare, expected_content_sha256)


def add_subtitles(adapter, ref, cues, expected_content_sha256=None):
    parsed = [SubtitleCue.model_validate(cue) for cue in cues]
    if not 1 <= len(parsed) <= 200:
        raise EditError("INVALID_SUBTITLES", "Supply 1..200 subtitle cues.")
    parsed.sort(key=lambda cue: cue.start)
    normalized = []
    for cue in parsed:
        start, duration = us(cue.start), us(cue.duration)
        text = cue.text.replace("\r\n", "\n").replace("\r", "\n")
        if (
            not text.strip()
            or "\0" in text
            or duration <= 0
            or (normalized and start < normalized[-1]["end_us"])
        ):
            raise EditError(
                "INVALID_SUBTITLES",
                "Cues must have nonblank text, positive microsecond duration and no overlaps.",
            )
        normalized.append(
            {"start_us": start, "duration_us": duration, "end_us": start + duration, "text": text}
        )

    def prepare(before):
        before = normalize_ranges(before)
        check_tracks(before)
        old_ids = {item["id"] for item in segments(before)}
        commands = [
            [
                "draft",
                "subtitle",
                "add",
                "--content",
                cue["text"],
                "--start",
                f"{cue['start_us']}us",
                "--duration",
                f"{cue['duration_us']}us",
            ]
            for cue in normalized
        ]

        def verify(after):
            after = normalize_ranges(after)
            check_tracks(after)
            added = [
                (track, item)
                for track in after["tracks"]
                for item in track.get("segments", [])
                if item["id"] not in old_ids
            ]
            added.sort(key=lambda pair: pair[1]["target_timerange"]["start"])
            require(len(added) == len(normalized), "Native subtitle count differs from the requested cues.")
            index = materials(after)
            result = []
            for (track, item), cue in zip(added, normalized):
                require(
                    track["type"] == "text"
                    and item["target_timerange"]
                    == {"start": cue["start_us"], "duration": cue["duration_us"]},
                    "Saved subtitle ranges differ from the requested cues.",
                )
                material = index.get(item.get("material_id"))
                require(material is not None and material[0] == "texts", "Subtitle text material is missing.")
                content = material[1].get("content")
                text = json.loads(content).get("text") if isinstance(content, str) else None
                require(text == cue["text"], "Saved subtitle text differs from the request.")
                result.append(
                    {
                        "segment_id": item["id"],
                        "track_id": track["id"],
                        "target_timerange_us": item["target_timerange"],
                        "text": text,
                    }
                )
            remaining = deepcopy(after["tracks"])
            for track in remaining:
                track["segments"] = [item for item in track.get("segments", []) if item["id"] in old_ids]
            remaining = [
                track for track in remaining if any(old["id"] == track["id"] for old in before["tracks"])
            ]
            require(remaining == before["tracks"], "Adding subtitles changed existing tracks or segments.")
            require(
                all(
                    track["id"] in {old["id"] for old in before["tracks"]} or track["type"] == "text"
                    for track in after["tracks"]
                ),
                "Adding subtitles created an unrelated track.",
            )
            preserve_materials(before, after)
            check_duration(after)
            return {"segments": result, "cue_count": len(result), "duration_us": after["duration"]}

        return commands, verify, {"cue_count": len(normalized)}

    return adapter.edit_copy(ref, "subtitles", prepare, expected_content_sha256)
