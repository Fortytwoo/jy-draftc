from __future__ import annotations

import json

import pytest

from jy_edit_mcp.core import EditError, KeyframePoint, TextStylePatch, TransformPatch, digest
from jy_edit_mcp.drafts import load_draft, save_draft
from jy_edit_mcp.editor import Editor


def test_split_trim_move_speed_and_reload(editor, timeline):
    project, _, clip = timeline
    split = editor.split(project, clip, 3)
    right = split["right_clip_id"]
    editor.trim(project, clip, 1, 3)
    editor.move(project, right, 2)
    editor.speed(project, right, 2)
    reloaded = Editor(editor.settings).load(project)
    left, tail = sorted(reloaded.tracks[0].clips, key=lambda c: c.start_us)
    assert (left.id, left.source_in_us, left.duration_us) == (clip, 1_000_000, 2_000_000)
    assert (tail.source_in_us, tail.duration_us, tail.start_us) == (3_000_000, 1_500_000, 2_000_000)
    assert reloaded.duration_us == 3_500_000


def test_rejected_edit_is_atomic(editor, timeline):
    project, track, clip = timeline
    before = editor.path(project).read_bytes()
    with pytest.raises(EditError, match="overlap"):
        editor.add_media(project, track, "video", "素材 red blue.mp4", 1)
    assert editor.path(project).read_bytes() == before
    with pytest.raises(EditError) as error:
        editor.move(project, clip, 2, expected_revision=0)
    assert error.value.code == "REVISION_CONFLICT"
    assert editor.path(project).read_bytes() == before


def test_media_boundary_and_source_ranges(editor, timeline, tmp_path):
    project, _, clip = timeline
    outside = tmp_path / "outside.mp4"
    outside.write_bytes(b"test")
    with pytest.raises(EditError) as error:
        editor.settings.media_path(str(outside))
    assert error.value.code == "PATH_OUTSIDE_MEDIA_ROOTS"
    with pytest.raises(EditError) as error:
        editor.trim(project, clip, 1, 20)
    assert error.value.code == "SOURCE_RANGE_INVALID"
    assert editor.load(project).duration_us == 6_000_000


def test_transform_patch_preserves_other_fields(editor, timeline):
    project, _, clip = timeline
    editor.transform(project, clip, TransformPatch(scale_x=1.5, opacity=0.5))
    editor.transform(project, clip, TransformPatch(x=0.4))
    transform = editor.load(project).tracks[0].clips[0].transform
    assert (transform.scale_x, transform.opacity, transform.x) == (1.5, 0.5, 0.4)


def test_subtitles_rollback_and_style_patch(editor, timeline, media):
    project, _, _ = timeline
    text_track = editor.add_track(project, "text", "字幕")["track_id"]
    result = editor.subtitles(project, text_track, "captions.srt")
    assert result["cue_count"] == 2
    text_id = result["clip_ids"][0]
    editor.text(project, text_id, None, TextStylePatch(size=9, bold=True))
    editor.text(project, text_id, "修改字幕", TextStylePatch(color="#123456"))
    _, clip = editor.clip(editor.load(project), text_id)
    assert clip.text == "修改字幕"
    assert clip.style.size == 9 and clip.style.bold
    before = editor.path(project).read_bytes()
    with pytest.raises(EditError):
        editor.subtitles(project, text_track, "captions.srt")
    assert editor.path(project).read_bytes() == before


def test_keyframe_range_and_guarded_split(editor, timeline):
    project, _, clip = timeline
    with pytest.raises(EditError) as error:
        editor.keyframes(project, clip, "alpha", [KeyframePoint(time=7, value=0.5)])
    assert error.value.code == "KEYFRAME_OUTSIDE_CLIP"
    editor.keyframes(
        project, clip, "alpha", [KeyframePoint(time=0, value=0.2), KeyframePoint(time=2, value=1)]
    )
    with pytest.raises(EditError) as error:
        editor.split(project, clip, 3)
    assert error.value.code == "SPLIT_REQUIRES_PLAIN_CLIP"
    editor.keyframes(project, clip, "alpha", [])
    assert editor.split(project, clip, 3)["right_clip_id"]


def test_native_draft_snapshot_stable_ids_and_no_source_write(editor, timeline, media):
    project, track, clip = timeline
    source_hash = digest(media / "素材 red blue.mp4")
    text_track = editor.add_track(project, "text", "字幕")["track_id"]
    editor.subtitles(project, text_track, "captions.srt")
    audio_track = editor.add_track(project, "audio", "音乐")["track_id"]
    audio = editor.add_media(project, audio_track, "audio", "素材 red blue.mp4", 0)["clip_id"]
    editor.audio(project, audio, 0.25, 0.5, 0.5)
    editor.keyframes(
        project, clip, "position_x", [KeyframePoint(time=0, value=0), KeyframePoint(time=2, value=0.1)]
    )
    saved = save_draft(editor, project)
    directory, manifest = load_draft(editor, saved["draft_id"])
    content = json.loads((directory / "draft_content.json").read_text(encoding="utf-8"))
    assert content["duration"] == 6_000_000
    assert content["tracks"][0]["id"] == track
    assert content["tracks"][0]["segments"][0]["id"] == clip
    assert content["tracks"][0]["segments"][0]["common_keyframes"]
    assert content["materials"]["audio_fades"]
    assert manifest["revision"] == editor.load(project).revision
    editor.move(project, clip, 7)
    assert digest(directory / "draft_content.json") == manifest["content_sha256"]
    assert digest(media / "素材 red blue.mp4") == source_hash
    with (directory / "draft_content.json").open("a", encoding="utf-8") as stream:
        stream.write(" ")
    with pytest.raises(EditError) as error:
        load_draft(editor, saved["draft_id"])
    assert error.value.code == "DRAFT_CHANGED"


@pytest.mark.parametrize("ripple,expected_start", [(False, 4_000_000), (True, 2_000_000)])
def test_remove_optional_same_track_ripple_is_atomic(editor, timeline, ripple, expected_start):
    project, _, first = timeline
    middle = editor.split(project, first, 2)["right_clip_id"]
    last = editor.split(project, middle, 4)["right_clip_id"]
    text_track = editor.add_track(project, "text", "Unlinked captions")["track_id"]
    caption = editor.add_text(project, text_track, "unchanged", 4, 1)["clip_id"]
    before = editor.path(project).read_bytes()
    with pytest.raises(EditError, match="Refresh"):
        editor.remove(project, middle, expected_revision=0, ripple=ripple)
    assert editor.path(project).read_bytes() == before
    revision = editor.load(project).revision
    result = editor.remove(project, middle, expected_revision=revision, ripple=ripple)
    assert result["revision"] == revision + 1
    saved = editor.load(project)
    assert editor.clip(saved, last)[1].start_us == expected_start
    assert editor.clip(saved, caption)[1].start_us == 4_000_000
    assert len(result["shifted_clips"]) == int(ripple)


def test_changed_source_is_rejected(editor, timeline, media):
    project, _, _ = timeline
    # Change only the copied per-test asset, never the session fixture.
    copy = media / "changed-copy.mp4"
    copy.write_bytes((media / "素材 red blue.mp4").read_bytes())
    track = editor.add_track(project, "video", "overlay")["track_id"]
    editor.add_media(project, track, "video", copy.name, 0)
    with copy.open("ab") as stream:
        stream.write(b"changed")
    try:
        with pytest.raises(EditError) as error:
            save_draft(editor, project)
        assert error.value.code == "ASSET_CHANGED"
    finally:
        copy.unlink()
