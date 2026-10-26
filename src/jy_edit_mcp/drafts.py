from __future__ import annotations

import os
import shutil
import time
from pathlib import Path

from filelock import FileLock

from .advanced import apply_advanced
from .core import EditError, Project, checked_id, digest, read_json, uid, write_json
from .editor import Editor, validate
from .resources import resolve


def sdk():
    # Loading the editor SDK is unnecessary for metadata and project CRUD tools.
    import pyJianYingDraft

    return pyJianYingDraft


def rgb(value: str):
    return tuple(int(value[i : i + 2], 16) / 255 for i in (1, 3, 5))


def compile_project(project: Project, directory: Path, draft_id: str):
    d = sdk()
    directory.mkdir(parents=True, exist_ok=False)
    script = d.ScriptFile(project.width, project.height, project.fps, False)
    script.content["id"] = draft_id
    for track in project.tracks:
        script.append_track(d.TrackSpec(getattr(d.TrackType, track.kind), name=track.name))
        script.tracks[track.name].track_id = track.id
        for clip in sorted(track.clips, key=lambda c: c.start_us):
            target = d.Timerange(clip.start_us, clip.duration_us)
            transform = clip.transform
            factor = 1.0
            if transform.fit == "cover" and clip.asset and clip.asset.width and clip.asset.height:
                ratios = (project.width / clip.asset.width, project.height / clip.asset.height)
                factor = max(ratios) / min(ratios)
            visual = d.ClipSettings(
                transform_x=transform.x,
                transform_y=transform.y,
                scale_x=transform.scale_x * factor,
                scale_y=transform.scale_y * factor,
                rotation=transform.rotation,
                alpha=transform.opacity,
                flip_horizontal=transform.flip_horizontal,
                flip_vertical=transform.flip_vertical,
            )
            if clip.kind == "text":
                style = clip.style
                segment = d.TextSegment(
                    clip.text,
                    target,
                    font=resolve("font", clip.font) if clip.font else None,
                    style=d.TextStyle(
                        size=style.size,
                        bold=style.bold,
                        italic=style.italic,
                        color=rgb(style.color),
                        align=style.align,
                        underline=style.underline,
                        vertical=style.vertical,
                        alpha=style.alpha,
                        letter_spacing=style.letter_spacing,
                        line_spacing=style.line_spacing,
                        auto_wrapping=style.auto_wrapping,
                        max_line_width=style.max_line_width,
                    ),
                    clip_settings=visual,
                    border=d.TextBorder(
                        width=style.border_width, color=rgb(style.border_color), alpha=style.border_alpha
                    )
                    if style.border_width
                    else None,
                    background=d.TextBackground(**clip.text_background.model_dump())
                    if clip.text_background
                    else None,
                    shadow=d.TextShadow(
                        **(clip.text_shadow.model_dump() | {"color": rgb(clip.text_shadow.color)})
                    )
                    if clip.text_shadow
                    else None,
                )
            elif clip.kind == "audio":
                segment = d.AudioSegment(
                    clip.asset.audio_path or clip.asset.path,
                    target,
                    source_timerange=d.Timerange(clip.source_in_us, clip.source_duration_us),
                    speed=clip.speed,
                    volume=clip.volume,
                )
                if clip.fade_in_us or clip.fade_out_us:
                    segment.add_fade(clip.fade_in_us, clip.fade_out_us)
            elif clip.kind == "sticker":
                segment = d.StickerSegment(clip.resource_id, target, clip_settings=visual)
            elif clip.kind in {"effect", "filter"}:
                effect = clip.effects[0]
                resource = resolve(effect.category, effect.name)
                segment = (
                    d.FilterSegment(resource, target, effect.intensity / 100)
                    if clip.kind == "filter"
                    else (d.EffectSegment(resource, target, effect.params))
                )
            else:
                source = (
                    d.Timerange(clip.source_in_us, clip.source_duration_us) if clip.kind == "video" else None
                )
                material = clip.asset.path
                if clip.crop:
                    c = clip.crop
                    material = d.VideoMaterial(
                        material,
                        crop_settings=d.CropSettings(
                            upper_left_x=c.left,
                            upper_left_y=c.top,
                            upper_right_x=c.right,
                            upper_right_y=c.top,
                            lower_left_x=c.left,
                            lower_left_y=c.bottom,
                            lower_right_x=c.right,
                            lower_right_y=c.bottom,
                        ),
                    )
                segment = d.VideoSegment(
                    material,
                    target,
                    source_timerange=source,
                    speed=clip.speed,
                    volume=clip.volume,
                    clip_settings=visual,
                )
                if clip.transition:
                    segment.add_transition(d.TransitionType[clip.transition], duration=clip.transition_us)
                if clip.fade_in_us or clip.fade_out_us:
                    segment.add_fade(clip.fade_in_us, clip.fade_out_us)
            apply_advanced(d, segment, clip)
            segment.segment_id = clip.id
            for property_name, points in clip.keyframes.items():
                for point in points:
                    if clip.kind == "audio":
                        segment.add_keyframe(round(point.time * 1e6), point.value)
                    else:
                        segment.add_keyframe(
                            d.KeyframeProperty[property_name], round(point.time * 1e6), point.value
                        )
            script.add_segment(segment, track.name)
            # SDK add_segment omits registration for standalone effect/filter clips and
            # speed materials referenced by text/sticker segments. Keep every direct ref resolvable.
            if clip.kind in {"text", "sticker"}:
                script.materials.speeds.append(segment.speed)
            elif clip.kind == "effect":
                script.materials.video_effects.append(segment.effect_inst)
            elif clip.kind == "filter":
                script.materials.filters.append(segment.material)
    script.dump(str(directory / "draft_content.json"))
    from pyJianYingDraft import assets

    meta = read_json(Path(assets.get_asset_path("DRAFT_META_TEMPLATE")))
    meta.update(
        {
            "draft_id": draft_id,
            "draft_name": project.name,
            "draft_fold_path": str(directory),
            "tm_duration": project.duration_us,
            "tm_draft_create": int(time.time() * 1e6),
            "tm_draft_modified": int(time.time() * 1e6),
        }
    )
    write_json(directory / "draft_meta_info.json", meta)


def save_draft(editor: Editor, project_id: str, expected_revision: int | None = None) -> dict:
    with FileLock(str(editor.path(project_id)) + ".lock", timeout=15):
        project = editor.load(project_id)
        if expected_revision is not None and project.revision != expected_revision:
            raise EditError(
                "REVISION_CONFLICT", "Refresh the project before saving.", actual_revision=project.revision
            )
        validate(project)
        if not project.duration_us:
            raise EditError("EMPTY_PROJECT", "Add clips before saving a draft.")
        editor.check_assets(project)
        draft_id = uid()
        staging = editor.root / "drafts" / (".stage-" + draft_id)
        final = editor.root / "drafts" / draft_id
        try:
            compile_project(project, staging, draft_id)
            meta = read_json(staging / "draft_meta_info.json")
            meta["draft_fold_path"] = str(final)
            write_json(staging / "draft_meta_info.json", meta)
            manifest = {
                "draft_id": draft_id,
                "project_id": project.id,
                "revision": project.revision,
                "duration_us": project.duration_us,
                "width": project.width,
                "height": project.height,
                "fps": project.fps,
                "content_sha256": digest(staging / "draft_content.json"),
                "plan": project.model_dump(),
                "warnings": [],
            }
            if any(c.transition for t in project.tracks for c in t.clips):
                manifest["warnings"].append(
                    "Transitions reference Jianying resources; availability and visual result require native verification."
                )
            if any(
                c.font
                or c.text_effect_id
                or c.bubble_effect_id
                or c.animations
                or c.effects
                or c.kind == "sticker"
                or c.mask
                or c.chroma
                or c.mix_mode
                or c.background
                for t in project.tracks
                for c in t.clips
            ):
                manifest["warnings"].append(
                    "Advanced resources are serialized, not native-verified. Cache, entitlement and visual/audio results require export verification."
                )
            write_json(staging / "manifest.json", manifest)
            os.rename(staging, final)
        finally:
            if staging.exists():
                shutil.rmtree(staging)  # Only this call's newly generated UUID staging directory.
        return {
            "draft_id": draft_id,
            "project_id": project.id,
            "revision": project.revision,
            "draft_path": str(final),
            "content_path": str(final / "draft_content.json"),
            "duration": project.duration_us / 1e6,
            "warnings": manifest["warnings"],
            "validation": {"generated": True, "opened_in_jianying": False, "exported": False},
        }


def load_draft(editor: Editor, draft_id: str) -> tuple[Path, dict]:
    directory = editor.root / "drafts" / checked_id(draft_id)
    if not (directory / "manifest.json").is_file():
        raise EditError("DRAFT_NOT_FOUND", "Use a draft_id returned by save_draft.")
    manifest = read_json(directory / "manifest.json")
    if digest(directory / "draft_content.json") != manifest["content_sha256"]:
        raise EditError("DRAFT_CHANGED", "Saved snapshot was changed outside the service; save a new draft.")
    if manifest.get("mode") == "template":
        from .templates import check_assets

        check_assets(manifest["source_hashes"])
    else:
        editor.check_assets(Project.model_validate(manifest["plan"]))
    return directory, manifest
