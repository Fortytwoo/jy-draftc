from __future__ import annotations

import json
import re
from functools import wraps
from importlib.metadata import version
from typing import Annotated, Literal

from mcp.server.fastmcp import FastMCP
from mcp.types import CallToolResult, ImageContent, TextContent, ToolAnnotations
from pydantic import Field, ValidationError

from . import __version__
from .core import (
    EditError,
    ExportOptions,
    KeyframePoint,
    Positive,
    Seconds,
    Settings,
    TextStylePatch,
    TrackKind,
    TransformPatch,
    digest,
    probe,
    run,
    uid,
    us,
)
from .drafts import sdk
from .editor import Editor
from .jobs import Jobs, validate_video
from .native_edits import CurveName, CurvePoint, SubtitleCue

Revision = Annotated[int | None, Field(ge=0)]
Limit = Annotated[int, Field(ge=1, le=200)]
Offset = Annotated[int, Field(ge=0)]
Speed = Annotated[float, Field(gt=0, le=100, allow_inf_nan=False)]


def build_server(settings: Settings | None = None) -> FastMCP:
    settings = settings or Settings.from_env()
    editor = Editor(settings)
    jobs = Jobs(editor)
    from .native_drafts import NativeDrafts

    native_drafts = NativeDrafts(editor)
    server = FastMCP(
        "jy-edit",
        instructions=(
            "Compose independent editing tools. All tool times are seconds; inspected plans use integer microseconds. "
            "Use returned project/track/clip/draft/job IDs. get_project paginates clips. "
            "Pass expected_revision to guard edits. Clips may overlap across tracks, never on one track. "
            "Save a draft snapshot before export; poll get_job until a terminal status. "
            "Use list_native_projects/get_native_draft for existing native drafts; native edits always create a NEW project copy. "
            "Use get_native_clip for detailed materials, list_native_operations/get_native_operation before retrying uncertain native edits. "
            "Draft generation, native rendering and opening in the Jianying UI are separate validation stages."
        ),
    )

    def capability(*, readonly=False, idempotent=False):
        def register(fn):
            @wraps(fn)
            def guarded(*args, **kwargs):
                try:
                    result = fn(*args, **kwargs)
                    if (
                        isinstance(result, list)
                        and result
                        and isinstance(result[0], (ImageContent, TextContent))
                    ):
                        return CallToolResult(content=result)
                    payload = {"ok": True, **result}
                    return CallToolResult(
                        content=[TextContent(type="text", text=json.dumps(payload, ensure_ascii=False))],
                        structuredContent=payload,
                    )
                except (
                    EditError,
                    ValidationError,
                    ValueError,
                    OSError,
                    TypeError,
                    IndexError,
                    KeyError,
                    NameError,
                ) as exc:
                    error = {
                        "code": exc.code if isinstance(exc, EditError) else "INVALID_OPERATION",
                        "message": str(exc),
                        **(exc.details if isinstance(exc, EditError) else {}),
                    }
                    payload = {"ok": False, "error": error}
                    return CallToolResult(
                        isError=True,
                        structuredContent=payload,
                        content=[TextContent(type="text", text=json.dumps(payload, ensure_ascii=False))],
                    )

            server.tool(
                annotations=ToolAnnotations(
                    readOnlyHint=readonly,
                    destructiveHint=False,
                    idempotentHint=idempotent or readonly,
                    openWorldHint=False,
                ),
                structured_output=False,
            )(guarded)
            return guarded

        return register

    @capability(readonly=True)
    def get_capabilities(check_native: bool = False) -> dict:
        """Inspect tools/backends. check_native=true runs jy-draftc self-check; existence alone is not native acceptance."""
        native = {"configured": bool(settings.native_exe), "available": False, "self_check_passed": None}
        if settings.native_exe and settings.native_exe.is_file():
            native["cli_version"] = run([str(settings.native_exe), "-v"]).stdout.strip()
            dll = settings.jy_dir / "videoeditor.dll" if settings.jy_dir else None
            if dll and dll.is_file():
                fingerprint = digest(dll)
                native.update(
                    runtime_path=str(settings.jy_dir),
                    dll_sha256=fingerprint,
                    available=fingerprint.upper() in native["cli_version"].upper(),
                )
            if check_native and native["available"]:
                result = run(
                    [str(settings.native_exe), "-c", "--jy-dir", str(settings.jy_dir), "-q"], timeout=90
                )
                native.update(self_check_passed=True, self_check_log=result.stdout[-6000:])
        return {
            "version": __version__,
            "mcp_sdk": version("mcp"),
            "draft_sdk": version("pyjianyingdraft"),
            "workspace": str(settings.workspace),
            "media_roots": [str(x) for x in settings.media_roots],
            "tool_time_unit": "seconds",
            "interval_end": "exclusive",
            "native": native,
            "native_project_editing": native_drafts.capabilities(),
            "ffmpeg": run([settings.ffmpeg, "-version"]).stdout.splitlines()[0],
            "ffprobe": run([settings.ffprobe, "-version"]).stdout.splitlines()[0],
            "features": [
                "video",
                "image",
                "audio",
                "text",
                "srt",
                "trim",
                "split",
                "move",
                "delete",
                "speed",
                "visual_transform",
                "volume",
                "audio_fades",
                "linear_keyframes",
                "resource_transitions",
                "draft_snapshots",
                "native_export",
                "export_cancellation",
                "resource_catalog",
                "resource_cache_inspection",
                "fonts",
                "fancy_text",
                "text_bubbles",
                "text_backgrounds",
                "text_shadows",
                "text_layout",
                "clip_animations",
                "video_effects",
                "filters",
                "effect_tracks",
                "filter_tracks",
                "masks",
                "chroma_key",
                "blend_modes",
                "canvas_backgrounds",
                "source_crop",
                "stickers",
                "audio_effects",
                "video_audio_fades",
                "color_keyframes",
                "local_templates",
                "template_replacement",
                "draft_conversion",
                "external_draft_export",
                "advanced_export_options",
                "same_track_ripple_removal",
                "native_speed_curves",
                "native_subtitle_cues",
                "native_edit_receipts",
            ],
            "limitations": [
                "Regular clip edits apply to service-created projects. Native drafts support copy-on-write splitting, speed curves, subtitle cues and same-track ripple removal; template tools remain separate.",
                "No ASR, AI material selection, generative video or cloud publishing.",
                "Resource effects need matching local assets/entitlements; static catalog and cache hints are not native verification.",
                "No fractional project fps, service-project curve speed, AI cutout, tracking, optical flow or cross-track ripple edits.",
                "Splitting clips with keyframes, transitions, fades or animations is explicitly rejected.",
                "Template segment replacement does not support variable-speed segments; online resource search/download is not included.",
            ],
        }

    @capability(readonly=True)
    def probe_media(path: str) -> dict:
        """Probe a local source (absolute path or relative to the first media root), including SHA-256 and streams."""
        return probe(settings, settings.media_path(path))

    @capability(readonly=True)
    def list_native_projects() -> dict:
        """List real Jianying desktop drafts and exact local:// refs. Separate from list_projects (service-created projects)."""
        return native_drafts.list()

    @capability(readonly=True)
    def get_native_draft(ref: str, offset: Offset = 0, limit: Limit = 50) -> dict:
        """Read an existing native project's saved main timeline, including encrypted drafts. Returns exact segment IDs, integer-microsecond ranges and content hash; does not edit or save."""
        return native_drafts.inspect(ref, offset, limit)

    @capability(readonly=True)
    def get_native_clip(ref: str, seg_id: str) -> dict:
        """Inspect one saved native segment, its raw settings, referenced materials (including text/curves/effects), missing references and content hash. Times are integer microseconds; no media files are opened."""
        return native_drafts.inspect_clip(ref, seg_id)

    @capability(readonly=True)
    def list_native_operations(offset: Offset = 0, limit: Limit = 50) -> dict:
        """List native edit receipts newest-first, including failed/uncertain copies. A started receipt is not proof a worker is alive. Query before retrying a timed-out edit."""
        return native_drafts.list_operations(offset, limit)

    @capability(readonly=True)
    def get_native_operation(operation_id: str) -> dict:
        """Read a durable native edit receipt, completed command count, output_ref, verification status and original native errors. Does not retry, delete, open or repair anything."""
        return native_drafts.operation(operation_id)

    @capability()
    def remove_native_clip(
        ref: str,
        seg_id: str,
        ripple: bool = False,
        expected_content_sha256: Annotated[str | None, Field(pattern=r"^[0-9a-f]{64}$")] = None,
    ) -> dict:
        """Remove a saved native segment in a NEW project copy. ripple=true shifts only subsequent clips on the same track by the removed duration; other tracks are not synchronized. Verifies all surviving segments/materials; magnetic main-track normalizations that disagree with saved ranges are rejected. Failure retains an unverified copy and receipt, never changes the source."""
        from .native_edits import remove_clip

        return remove_clip(native_drafts, ref, seg_id, ripple, expected_content_sha256)

    @capability()
    def set_native_clip_speed(
        ref: str,
        seg_id: str,
        speed: Annotated[float | None, Field(ge=0.01, le=100, allow_inf_nan=False)] = None,
        curve_name: CurveName | None = None,
        curve_points: Annotated[list[CurvePoint] | None, Field(min_length=2, max_length=50)] = None,
        expected_content_sha256: Annotated[str | None, Field(pattern=r"^[0-9a-f]{64}$")] = None,
    ) -> dict:
        """Set native video speed in a NEW project copy. Choose exactly one: constant speed, named curve or custom points (normalized source x=0..1, speed multiplier y=0.01..100, strictly ordered endpoints 0 and 1). Keeps source range/start; no ripple. Overlaps or unrelated changes are rejected by readback. Curve serialization is not rendered-motion acceptance."""
        from .native_edits import set_speed

        return set_speed(native_drafts, ref, seg_id, speed, curve_name, curve_points, expected_content_sha256)

    @capability()
    def add_native_subtitles(
        ref: str,
        cues: Annotated[list[SubtitleCue], Field(min_length=1, max_length=200)],
        expected_content_sha256: Annotated[str | None, Field(pattern=r"^[0-9a-f]{64}$")] = None,
    ) -> dict:
        """Add explicit sentence-level subtitle cues to a NEW native project copy. Each cue has text/start/duration in timeline SECONDS. Cues must not overlap; vendor selects subtitle track(s). Verifies saved text, ranges and existing content. This is not ASR. Batch failure leaves only an unverified copy, not a partially accepted result; inspect the receipt before retrying."""
        from .native_edits import add_subtitles

        return add_subtitles(native_drafts, ref, cues, expected_content_sha256)

    @capability()
    def split_native_clip(
        ref: str,
        seg_id: str,
        points: Annotated[list[Positive], Field(min_length=1, max_length=200)],
        absolute: bool = False,
        expected_content_sha256: Annotated[str | None, Field(pattern=r"^[0-9a-f]{64}$")] = None,
    ) -> dict:
        """Split an existing encrypted/native draft through vendor lyra-cli. ALWAYS duplicates into a new native project first; source is never patched. points are SECONDS relative to the segment, or timeline-absolute with absolute=true, strictly inside. Use seg_id/hash from get_native_draft or current-project read. Returns original/new IDs, exact saved ranges, output_ref/path and catalog warnings. It does not open/reload the UI or export video; do not retry blindly after an uncertain result."""
        return native_drafts.split(ref, seg_id, points, absolute, expected_content_sha256)

    @capability()
    def prepare_native_copy(
        ref: str,
        expected_content_sha256: Annotated[str | None, Field(pattern=r"^[0-9a-f]{64}$")] = None,
    ) -> dict:
        """After fully exiting Jianying, prepare a successful native edit copy for opening. Repairs only that receipt-proven copy's project identity and root content mirror plus its own native catalog entry, retaining original-byte backups and reporting actual output encoding (metadata may become plain JSON). Never patches source projects or splits more clips. Refuses changed copies or a running editor. Catalog readback is not UI-open acceptance."""
        from .native_catalog import prepare_copy

        return prepare_copy(native_drafts, ref, expected_content_sha256)

    @capability()
    def extract_frame(path: str, at: Seconds = 0) -> dict:
        """Read an actual source frame and return its image to the agent; at is source seconds. Max width 1280."""
        import base64

        source = settings.media_path(path)
        info = probe(settings, source, with_hash=False)
        if not info["video_codec"]:
            raise EditError("VISUAL_MEDIA_REQUIRED", "Source must contain an image/video stream.")
        if info["duration_us"] is not None and us(at) >= info["duration_us"]:
            raise EditError("FRAME_OUTSIDE_SOURCE", "at must be before the end of the source.")
        output = editor.root / "frames" / (uid() + ".png")
        run(
            [
                settings.ffmpeg,
                "-v",
                "error",
                "-ss",
                str(at),
                "-i",
                str(source),
                "-frames:v",
                "1",
                "-vf",
                "scale='min(1280,iw)':-1",
                str(output),
            ]
        )
        if not output.is_file():
            raise EditError("FRAME_MISSING", "No frame decoded at the requested time.")
        return [
            TextContent(type="text", text=json.dumps({"path": str(output), "at": at}, ensure_ascii=False)),
            ImageContent(
                type="image", mimeType="image/png", data=base64.b64encode(output.read_bytes()).decode()
            ),
        ]

    @capability()
    def create_project(
        name: str,
        width: Annotated[int, Field(ge=16, le=7680, multiple_of=2)] = 1080,
        height: Annotated[int, Field(ge=16, le=7680, multiple_of=2)] = 1920,
        fps: Literal[24, 25, 30, 50, 60] = 30,
    ) -> dict:
        """Create an empty editable timeline. Add tracks and clips with the returned project_id."""
        return editor.create(name, width, height, fps)

    @capability(readonly=True)
    def list_projects(offset: Offset = 0, limit: Limit = 50) -> dict:
        """List service-created projects in ID order; this does not enumerate the user's Jianying drafts."""
        paths = sorted((editor.root / "projects").glob("*.json"))
        return {
            "projects": [editor.summary(editor.load(p.stem)) for p in paths[offset : offset + limit]],
            "next_offset": offset + limit if offset + limit < len(paths) else None,
        }

    @capability(readonly=True)
    def get_project(project_id: str, offset: Offset = 0, limit: Limit = 50) -> dict:
        """Inspect revision, layer order, stable clip IDs and paginated edit state. Raw times are integer microseconds."""
        return editor.get(project_id, offset, limit)

    @capability()
    def add_track(project_id: str, kind: TrackKind, name: str, expected_revision: Revision = None) -> dict:
        """Add a video/audio/text track. Later visual tracks are above earlier tracks; images use video tracks."""
        return editor.add_track(project_id, kind, name, expected_revision)

    @capability()
    def reorder_track(
        project_id: str, track_id: str, index: Offset, expected_revision: Revision = None
    ) -> dict:
        """Move a track to a zero-based layer index, preserving all clips. Higher visual indices appear above lower ones."""

        def op(project):
            track = editor.track(project, track_id)
            if index >= len(project.tracks):
                raise EditError("INVALID_TRACK_INDEX", "Index must be inside the track list.")
            project.tracks.remove(track)
            project.tracks.insert(index, track)
            return {"track_id": track_id, "index": index}

        return editor.edit(project_id, expected_revision, op)

    @capability()
    def add_video_clip(
        project_id: str,
        track_id: str,
        path: str,
        start: Seconds = 0,
        source_in: Seconds = 0,
        source_duration: Positive | None = None,
        speed: Speed = 1,
        expected_revision: Revision = None,
    ) -> dict:
        """Place video on a video track. start is timeline seconds; source_duration is source seconds before speed."""
        return editor.add_media(
            project_id, track_id, "video", path, start, source_in, source_duration, speed, expected_revision
        )

    @capability()
    def add_audio_clip(
        project_id: str,
        track_id: str,
        path: str,
        start: Seconds = 0,
        source_in: Seconds = 0,
        source_duration: Positive | None = None,
        speed: Speed = 1,
        expected_revision: Revision = None,
    ) -> dict:
        """Place audio on an audio track, including an audio stream from a video file; source_duration is before speed."""
        return editor.add_media(
            project_id, track_id, "audio", path, start, source_in, source_duration, speed, expected_revision
        )

    @capability()
    def add_image_clip(
        project_id: str,
        track_id: str,
        path: str,
        duration: Positive,
        start: Seconds = 0,
        expected_revision: Revision = None,
    ) -> dict:
        """Place a still image on a video track for an explicit timeline duration in seconds."""
        return editor.add_media(
            project_id, track_id, "image", path, start, duration=duration, expected_revision=expected_revision
        )

    @capability()
    def add_text_clip(
        project_id: str,
        track_id: str,
        text: str,
        duration: Positive,
        start: Seconds = 0,
        expected_revision: Revision = None,
    ) -> dict:
        """Add editable native text. Use set_text_style and set_clip_transform to format/place it."""
        return editor.add_text(project_id, track_id, text, start, duration, expected_revision)

    @capability()
    def import_subtitles(
        project_id: str, track_id: str, path: str, offset: Seconds = 0, expected_revision: Revision = None
    ) -> dict:
        """Import a UTF-8 SRT as editable native text clips in one atomic operation; overlapping cues are rejected."""
        return editor.subtitles(project_id, track_id, path, offset, expected_revision)

    @capability()
    def trim_clip(
        project_id: str,
        clip_id: str,
        source_in: Seconds,
        source_out: Positive,
        expected_revision: Revision = None,
    ) -> dict:
        """Trim video/audio using absolute source [in,out) seconds. Keep timeline start; duration follows current speed. No ripple."""
        return editor.trim(project_id, clip_id, source_in, source_out, expected_revision)

    @capability()
    def split_clip(project_id: str, clip_id: str, at: Seconds, expected_revision: Revision = None) -> dict:
        """Split a plain clip at absolute timeline seconds. Original ID stays on the left; return a new right ID."""
        return editor.split(project_id, clip_id, at, expected_revision)

    @capability()
    def move_clip(
        project_id: str,
        clip_id: str,
        start: Seconds,
        track_id: str | None = None,
        expected_revision: Revision = None,
    ) -> dict:
        """Move a clip to an absolute timeline start, optionally to another compatible track. No ripple or source trim."""
        return editor.move(project_id, clip_id, start, track_id, expected_revision)

    @capability()
    def remove_clip(
        project_id: str, clip_id: str, expected_revision: Revision = None, ripple: bool = False
    ) -> dict:
        """Remove a service-project clip atomically. ripple=true shifts subsequent clips on the SAME track by its duration; other tracks, sources and saved snapshots stay unchanged. Default keeps gaps."""
        return editor.remove(project_id, clip_id, expected_revision, ripple)

    @capability()
    def set_clip_duration(
        project_id: str, clip_id: str, duration: Positive, expected_revision: Revision = None
    ) -> dict:
        """Set image/text/sticker/effect/filter duration; video/audio duration is controlled through source trimming and speed."""

        def op(project):
            _, clip = editor.clip(project, clip_id)
            if clip.kind not in {"text", "image", "sticker", "effect", "filter"}:
                raise EditError("STATIC_CLIP_REQUIRED", "Use trim_clip or set_clip_speed for video/audio.")
            clip.duration_us = us(duration)

        return editor.edit(project_id, expected_revision, op)

    @capability()
    def set_clip_transform(
        project_id: str, clip_id: str, transform: TransformPatch, expected_revision: Revision = None
    ) -> dict:
        """Patch visual transform. Omitted fields stay unchanged. x/y are normalized around center (+y up); scale is a factor."""
        return editor.transform(project_id, clip_id, transform, expected_revision)

    @capability()
    def set_clip_speed(
        project_id: str, clip_id: str, speed: Speed, expected_revision: Revision = None
    ) -> dict:
        """Set constant video/audio speed; preserve source interval and timeline start, recalculate duration. No ripple."""
        return editor.speed(project_id, clip_id, speed, expected_revision)

    @capability()
    def set_clip_audio(
        project_id: str,
        clip_id: str,
        volume: Annotated[float, Field(ge=0, le=10, allow_inf_nan=False)] = 1,
        fade_in: Seconds = 0,
        fade_out: Seconds = 0,
        expected_revision: Revision = None,
    ) -> dict:
        """Set volume (0 mute, 1 original) and fades in timeline seconds. Video supports volume; use an audio clip for fades."""
        return editor.audio(project_id, clip_id, volume, fade_in, fade_out, expected_revision)

    @capability()
    def set_text_style(
        project_id: str,
        clip_id: str,
        style: TextStylePatch,
        text: str | None = None,
        expected_revision: Revision = None,
    ) -> dict:
        """Patch editable text style and optionally replace text. Omitted style fields stay unchanged; size is native Jianying units."""
        return editor.text(project_id, clip_id, text, style, expected_revision)

    @capability(readonly=True)
    def list_transitions(query: str = "", offset: Offset = 0, limit: Limit = 50) -> dict:
        """Discover exact transition names from the pinned SDK. Catalog membership does not prove local resource availability."""
        items = [
            {"name": name, "resource_id": member.value.resource_id}
            for name, member in sdk().TransitionType.__members__.items()
            if query.lower() in name.lower()
        ]
        return {
            "transitions": items[offset : offset + limit],
            "total": len(items),
            "next_offset": offset + limit if offset + limit < len(items) else None,
            "requires_cached_resources": True,
        }

    @capability()
    def set_transition(
        project_id: str,
        clip_id: str,
        name: str | None = None,
        duration: Seconds = 0.5,
        expected_revision: Revision = None,
    ) -> dict:
        """Set an outgoing transition to the next adjacent visual clip. name=null clears it; use list_transitions for exact names."""
        if name is not None and name not in sdk().TransitionType.__members__:
            raise EditError("TRANSITION_NOT_FOUND", "Use an exact name returned by list_transitions.")

        def op(project):
            _, clip = editor.clip(project, clip_id)
            if clip.kind not in {"video", "image"}:
                raise EditError("VISUAL_MEDIA_REQUIRED", "Transitions apply to video/image clips.")
            clip.transition, clip.transition_us = name, us(duration) if name else 0

        return editor.edit(project_id, expected_revision, op)

    @capability()
    def set_keyframes(
        project_id: str,
        clip_id: str,
        property_name: Literal[
            "position_x",
            "position_y",
            "rotation",
            "scale_x",
            "scale_y",
            "alpha",
            "volume",
            "uniform_scale",
            "brightness",
            "contrast",
            "saturation",
        ],
        points: Annotated[list[KeyframePoint], Field(max_length=500)],
        expected_revision: Revision = None,
    ) -> dict:
        """Replace one property's linear keyframes. Point times are relative clip seconds; [] clears that property's keyframes."""
        return editor.keyframes(project_id, clip_id, property_name, points, expected_revision)

    @capability()
    def save_draft(project_id: str, expected_revision: Revision = None) -> dict:
        """Compile an immutable new editable draft snapshot. Does not install it into Jianying or claim UI/export acceptance."""
        from .drafts import save_draft as save

        return save(editor, project_id, expected_revision)

    @capability()
    def export_video(
        draft_id: str,
        codec: Literal["h264", "hevc"] = "h264",
        bitrate: str = "4M",
        timeout: Annotated[int, Field(ge=10, le=3600)] = 900,
        options: ExportOptions | None = None,
    ) -> dict:
        """Start native MP4 export of a saved snapshot. Returns a durable job_id; poll get_job. Output stays in the workspace."""
        if not re.fullmatch(r"[1-9][0-9]{0,8}(?:[KkMm])?", bitrate):
            raise EditError("INVALID_BITRATE", "Use an integer bitrate or a K/M suffix, for example 4M.")
        return jobs.export(draft_id, codec, bitrate, timeout, options)

    @capability(readonly=True)
    def get_job(job_id: str) -> dict:
        """Read job state, logs and artifacts. Terminal statuses: succeeded, failed, cancelled, interrupted."""
        return jobs.get(job_id)

    @capability(idempotent=True)
    def cancel_job(job_id: str) -> dict:
        """Request cancellation. Keep polling until terminal; cancellation_requested is not a confirmed cancelled state."""
        return jobs.cancel(job_id)

    @capability(readonly=True)
    def validate_output(job_id: str) -> dict:
        """Re-probe and fully decode a succeeded job's MP4; check canvas and duration against the saved timeline."""
        directory = jobs.directory(job_id)
        from .core import read_json

        job = read_json(directory / "job.json")
        if job["status"] != "succeeded":
            raise EditError("OUTPUT_NOT_READY", "Wait for job status succeeded.")
        return validate_video(settings, directory / "output.mp4", job["expected"])

    from .advanced_tools import register_advanced
    from .template_tools import register_templates

    register_advanced(capability, editor)
    register_templates(capability, editor, jobs)
    return server


def main():
    build_server().run(transport="stdio")


if __name__ == "__main__":
    main()
