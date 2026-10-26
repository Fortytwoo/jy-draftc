"""Real protocol contracts, SDK material serialization, rollback and template round trips."""

import json
import shutil
from pathlib import Path

import pytest
from test_protocol import call, client

from jy_edit_mcp.core import EditError, KeyframePoint, digest
from jy_edit_mcp.drafts import save_draft
from jy_edit_mcp.resources import ENUMS, catalog


@pytest.mark.parametrize("category", list(ENUMS))
def test_catalog_is_paged_and_never_claims_runtime_verification(category):
    rows = catalog(category, limit=1)
    assert len(rows["resources"]) == 1 and rows["total"] >= 1
    assert rows["resources"][0]["native_verified"] is False
    assert rows["resources"][0]["category"] == category
    assert rows["availability"] == "unverified"


async def advanced_timeline(session):
    pid = (await call(session, "create_project", name="Advanced SDK", width=320, height=180))["project_id"]
    tracks = {}
    for kind in ["video", "audio", "text", "sticker", "effect", "filter"]:
        tracks[kind] = (await call(session, "add_track", project_id=pid, kind=kind, name=kind))["track_id"]
    video = (
        await call(
            session, "add_video_clip", project_id=pid, track_id=tracks["video"], path="素材 red blue.mp4"
        )
    )["clip_id"]
    audio = (
        await call(
            session, "add_audio_clip", project_id=pid, track_id=tracks["audio"], path="素材 red blue.mp4"
        )
    )["clip_id"]
    text = (
        await call(
            session, "add_text_clip", project_id=pid, track_id=tracks["text"], text="花字测试", duration=6
        )
    )["clip_id"]
    names = {}
    for category in ENUMS:
        data = await call(session, "list_resources", category=category, limit=1)
        names[category] = data["resources"][0]["name"]
    await call(session, "set_text_font", project_id=pid, clip_id=text, name=names["font"])
    await call(session, "set_text_effect", project_id=pid, clip_id=text, effect_id="synthetic-fancy")
    await call(
        session,
        "set_text_bubble",
        project_id=pid,
        clip_id=text,
        effect_id="synthetic-bubble",
        resource_id="synthetic-resource",
    )
    await call(
        session,
        "set_text_background",
        project_id=pid,
        clip_id=text,
        background={"color": "#123456", "round_radius": 0.2},
    )
    await call(
        session, "set_text_shadow", project_id=pid, clip_id=text, shadow={"color": "#654321", "angle": 25}
    )
    await call(
        session,
        "set_text_style",
        project_id=pid,
        clip_id=text,
        style={
            "underline": True,
            "vertical": True,
            "letter_spacing": 2,
            "line_spacing": 3,
            "alpha": 0.8,
            "max_line_width": 0.6,
            "border_width": 10,
            "border_alpha": 0.3,
        },
    )
    for category in ["video_intro", "video_outro", "text_intro", "text_outro", "text_loop"]:
        await call(
            session,
            "set_clip_animation",
            project_id=pid,
            clip_id=text if category.startswith("text") else video,
            category=category,
            name=names[category],
            duration=0.3,
        )
    for category in ["video_effect", "character_effect", "filter", "audio_scene", "tone", "speech_to_song"]:
        await call(
            session,
            "add_clip_effect",
            project_id=pid,
            clip_id=audio if category in {"audio_scene", "tone", "speech_to_song"} else video,
            effect={"category": category, "name": names[category]},
        )
    await call(
        session,
        "set_clip_mask",
        project_id=pid,
        clip_id=video,
        mask={"name": "矩形", "feather": 20, "round_corner": 30},
    )
    await call(
        session,
        "set_clip_chroma",
        project_id=pid,
        clip_id=video,
        chroma={"color": "#00FF00FF", "intensity": 35},
    )
    await call(session, "set_clip_mix_mode", project_id=pid, clip_id=video, name=names["mix_mode"])
    await call(
        session,
        "set_clip_background",
        project_id=pid,
        clip_id=video,
        background={"fill_type": "color", "color": "#112233FF"},
    )
    await call(session, "set_clip_crop", project_id=pid, clip_id=video, crop={"left": 0.1, "right": 0.9})
    await call(
        session, "set_clip_audio", project_id=pid, clip_id=video, fade_in=0.2, fade_out=0.2, volume=0.5
    )
    for prop in ["brightness", "contrast", "saturation", "uniform_scale"]:
        await call(
            session,
            "set_keyframes",
            project_id=pid,
            clip_id=video,
            property_name=prop,
            points=[{"time": 0, "value": 1}, {"time": 1, "value": 1.1}],
        )
    sticker = (
        await call(
            session,
            "add_sticker_clip",
            project_id=pid,
            track_id=tracks["sticker"],
            resource_id="synthetic-sticker",
            duration=2,
        )
    )["clip_id"]
    await call(session, "set_clip_transform", project_id=pid, clip_id=sticker, transform={"scale_x": 0.5})
    for category, kind in [("video_effect", "effect"), ("filter", "filter")]:
        await call(
            session,
            "add_effect_clip",
            project_id=pid,
            track_id=tracks[kind],
            duration=2,
            effect={"category": category, "name": names[category], "intensity": 25},
        )
    return pid, video, text


async def test_advanced_protocol_serializes_native_materials_and_atomic_failures(media, tmp_path):
    async with client(media, tmp_path / "advanced") as session:
        pid, video, text = await advanced_timeline(session)
        entry = catalog("font", limit=1)["resources"][0]
        cache = media / (entry["resource_id"] + ".synthetic-cache")
        cache.write_text("synthetic cache hint only", encoding="utf-8")
        try:
            available = await call(
                session,
                "check_resource_availability",
                category="font",
                name=entry["name"],
                cache_roots=[str(media)],
            )
            assert available["cache_status"] == "candidate_found" and not available["native_verified"]
        finally:
            cache.unlink()
        saved = await call(session, "save_draft", project_id=pid)
        content = json.loads(Path(saved["content_path"]).read_text(encoding="utf-8"))
        materials = content["materials"]
        material_ids = {m.get("id") for bucket in materials.values() for m in bucket}
        for track in content["tracks"]:
            for segment in track["segments"]:
                assert segment["material_id"] in material_ids
                assert set(segment.get("extra_material_refs", [])) <= material_ids
        for bucket in [
            "material_animations",
            "video_effects",
            "effects",
            "masks",
            "common_mask",
            "chromas",
            "canvases",
            "stickers",
            "audio_effects",
            "audio_fades",
        ]:
            assert materials[bucket], bucket
        text_style = json.loads(materials["texts"][0]["content"])["styles"][0]
        assert text_style["font"]["id"] and text_style["effectStyle"]["id"] == "synthetic-fancy"
        assert text_style["underline"] and text_style["shadows"]
        assert materials["texts"][0]["typesetting"] == 1
        assert materials["videos"][0]["crop"]["upper_left_x"] == 0.1
        assert saved["warnings"]
        before = await call(session, "get_project", project_id=pid)
        for tool, args in [
            ("set_clip_crop", {"clip_id": video, "crop": {"left": 0.8, "right": 0.2}}),
            ("set_clip_mask", {"clip_id": text, "mask": {"name": "圆形"}}),
            ("set_text_font", {"clip_id": text, "name": "missing-font"}),
            (
                "set_clip_animation",
                {
                    "clip_id": video,
                    "category": "video_group",
                    "name": catalog("video_group", limit=1)["resources"][0]["name"],
                },
            ),
            (
                "set_keyframes",
                {"clip_id": video, "property_name": "scale_x", "points": [{"time": 0, "value": 1}]},
            ),
        ]:
            result = await session.call_tool(tool, {"project_id": pid, **args})
            assert result.isError, (tool, result)
        assert (await call(session, "get_project", project_id=pid))["revision"] == before["revision"]
        # Clear and replace semantics work independently of serialized historical snapshots.
        effects = next(c for c in before["clips"] if c["id"] == video)["effects"]
        effect = effects[0]
        await call(
            session,
            "update_clip_effect",
            project_id=pid,
            clip_id=video,
            effect_id=effect["id"],
            effect=effect,
        )
        await call(session, "remove_clip_effect", project_id=pid, clip_id=video, effect_id=effect["id"])
        for tool, arg in [
            ("set_text_font", "name"),
            ("set_text_effect", "effect_id"),
            ("set_text_bubble", "effect_id"),
            ("set_text_background", "background"),
            ("set_text_shadow", "shadow"),
        ]:
            await call(session, tool, project_id=pid, clip_id=text, **{arg: None})
        for tool, arg in [
            ("set_clip_mask", "mask"),
            ("set_clip_chroma", "chroma"),
            ("set_clip_mix_mode", "name"),
            ("set_clip_background", "background"),
            ("set_clip_crop", "crop"),
        ]:
            await call(session, tool, project_id=pid, clip_id=video, **{arg: None})
        await call(
            session, "set_clip_animation", project_id=pid, clip_id=video, category="video_intro", name=None
        )
        await call(session, "save_draft", project_id=pid)


async def test_template_copy_replace_import_and_snapshot_without_source_mutation(media, tmp_path):
    from jy_edit_mcp.core import Settings
    from jy_edit_mcp.editor import Editor

    inputs = tmp_path / "inputs"
    shutil.copytree(media, inputs)
    workspace = tmp_path / "templates-work"
    editor = Editor(Settings(workspace, (inputs,), shutil.which("ffmpeg"), shutil.which("ffprobe")))
    pid = editor.create("Template test", 320, 180)["project_id"]
    vtrack = editor.add_track(pid, "video", "Video")["track_id"]
    clip = editor.add_media(pid, vtrack, "video", "素材 red blue.mp4", 0, duration=2)["clip_id"]
    ttrack = editor.add_track(pid, "text", "Text")["track_id"]
    text = editor.add_text(pid, ttrack, "Original", 0, 2)["clip_id"]
    saved = save_draft(editor, pid)
    source = inputs / "template.json"
    source.write_bytes(Path(saved["content_path"]).read_bytes())
    original = digest(source)
    async with client(inputs, workspace) as session:
        first = await call(session, "import_local_template", path=str(source), name="Local template")
        tid = first["template_id"]
        assert (await call(session, "list_templates"))["total"] == 1
        copied = await call(session, "duplicate_template", template_id=tid, name="Copy")
        await call(
            session,
            "replace_template_text",
            template_id=tid,
            track_id=ttrack,
            segment_id=text,
            text="替换标题",
            expected_revision=0,
        )
        await call(
            session,
            "replace_template_material_by_name",
            template_id=tid,
            material_name="素材 red blue.mp4",
            path="素材 red blue.mp4",
            kind="video",
        )
        await call(
            session,
            "replace_template_segment",
            template_id=tid,
            track_id=vtrack,
            segment_id=clip,
            path="素材 red blue.mp4",
            source_in=3,
            source_duration=2,
        )
        result = await call(session, "save_template_draft", template_id=tid)
        data = json.loads(Path(result["content_path"]).read_text(encoding="utf-8"))
        assert "替换标题" in data["materials"]["texts"][0]["content"]
        assert data["tracks"][0]["segments"][0]["source_timerange"]["start"] == 3_000_000
        assert (
            json.loads(
                (workspace / "templates" / (copied["template_id"] + ".json")).read_text(encoding="utf-8")
            )["revision"]
            == 0
        )
        assert not (await call(session, "inspect_template_resources", template_id=tid))["native_verified"]
        # Copy a new independent text track, offset by 2 seconds; its dependencies follow.
        other_pid = (await call(session, "create_project", name="Other"))["project_id"]
        other_track = (
            await call(session, "add_track", project_id=other_pid, kind="text", name="Other text")
        )["track_id"]
        await call(
            session, "add_text_clip", project_id=other_pid, track_id=other_track, text="Added", duration=1
        )
        other_draft = await call(session, "save_draft", project_id=other_pid)
        other = await call(session, "import_local_template", path=other_draft["content_path"])
        await call(
            session,
            "import_template_track",
            template_id=tid,
            source_template_id=other["template_id"],
            source_track_id=other_track,
            offset=2,
        )
        state = await call(session, "get_template", template_id=tid)
        assert len(state["tracks"]) == 3
        bad = await session.call_tool(
            "import_template_track",
            {"template_id": tid, "source_template_id": other["template_id"], "source_track_id": other_track},
        )
        assert bad.isError and bad.structuredContent["error"]["code"] == "DUPLICATE_ID"
        after = await call(session, "get_template", template_id=tid)
        assert after["revision"] == state["revision"]
        assert digest(source) == original
        escaped = await session.call_tool("import_local_template", {"path": str(tmp_path / "outside.json")})
        assert escaped.isError


def test_uniform_scale_conflict_rolls_back(editor, timeline):
    pid, _, clip = timeline
    editor.keyframes(pid, clip, "uniform_scale", [KeyframePoint(time=0, value=1)])
    before = editor.path(pid).read_bytes()
    with pytest.raises(EditError, match="uniform_scale"):
        editor.keyframes(pid, clip, "scale_x", [KeyframePoint(time=0, value=2)])
    assert editor.path(pid).read_bytes() == before


@pytest.mark.parametrize(
    "mode,expected_start", [("cut_head", 1), ("cut_tail", 0), ("cut_tail_align", 0), ("shrink", 0.5)]
)
async def test_template_shrink_modes_keep_source_and_target_durations_equal(
    media, tmp_path, mode, expected_start
):
    async with client(media, tmp_path / mode) as session:
        pid = (await call(session, "create_project", name=mode))["project_id"]
        track = (await call(session, "add_track", project_id=pid, kind="video", name="Video"))["track_id"]
        clip = (
            await call(
                session,
                "add_video_clip",
                project_id=pid,
                track_id=track,
                path="素材 red blue.mp4",
                source_duration=2,
            )
        )["clip_id"]
        saved = await call(session, "save_draft", project_id=pid)
        template = await call(session, "import_local_template", path=saved["content_path"])
        await call(
            session,
            "replace_template_segment",
            template_id=template["template_id"],
            track_id=track,
            segment_id=clip,
            path="素材 red blue.mp4",
            source_duration=1,
            shrink=mode,
        )
        state = await call(session, "get_template", template_id=template["template_id"])
        segment = state["segments"][0]
        assert segment["target_timerange"] == {"start": int(expected_start * 1e6), "duration": 1_000_000}
        assert segment["source_timerange"]["duration"] == 1_000_000
