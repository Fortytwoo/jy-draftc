from __future__ import annotations

import copy
import re
from pathlib import Path

from filelock import FileLock

from .core import (
    Asset,
    Clip,
    EditError,
    KeyframePoint,
    Project,
    Settings,
    TextStyle,
    TextStylePatch,
    Track,
    Transform,
    TransformPatch,
    checked_id,
    digest,
    probe,
    read_json,
    run,
    uid,
    us,
    write_json,
)


def validate(project: Project) -> None:
    from .advanced import validate_advanced

    ids = set()
    bottom_video = next((t.id for t in project.tracks if t.kind == "video"), None)
    for track in project.tracks:
        for item in [track, *track.clips]:
            if item.id in ids:
                raise EditError("DUPLICATE_ID", "Track and clip IDs must be unique.")
            ids.add(item.id)
        clips = sorted(track.clips, key=lambda c: c.start_us)
        for i, clip in enumerate(clips):
            validate_advanced(clip)
            if clip.background and track.id != bottom_video:
                raise EditError(
                    "BOTTOM_VIDEO_TRACK_REQUIRED", "Canvas fill is only supported on the bottom video track."
                )
            if ("video" if clip.kind == "image" else clip.kind) != track.kind:
                raise EditError("TRACK_TYPE_MISMATCH", "Clip kind does not match the track.")
            if i and clips[i - 1].end_us > clip.start_us:
                raise EditError(
                    "CLIP_OVERLAP", "Clips on one track may not overlap; use another track.", clip_id=clip.id
                )
            if clip.kind in {"video", "audio"}:
                if not clip.asset or clip.asset.duration_us is None:
                    raise EditError("INVALID_MEDIA", "Timed media must have a known duration.")
                if clip.source_in_us + clip.source_duration_us > clip.asset.duration_us:
                    raise EditError("SOURCE_RANGE_INVALID", "Source range exceeds media duration.")
                if abs(round(clip.source_duration_us / clip.speed) - clip.duration_us) > 1:
                    raise EditError(
                        "DURATION_MISMATCH", "Source range, speed and timeline duration disagree."
                    )
            if max(clip.fade_in_us, clip.fade_out_us) > clip.duration_us:
                raise EditError("FADE_TOO_LONG", "Each fade must fit inside the clip.")
            for points in clip.keyframes.values():
                if any(us(p.time) > clip.duration_us for p in points):
                    raise EditError("KEYFRAME_OUTSIDE_CLIP", "Keyframe time is relative to the clip.")
            if clip.transition:
                if i + 1 == len(clips) or clip.end_us != clips[i + 1].start_us:
                    raise EditError(
                        "TRANSITION_REQUIRES_NEIGHBOR", "An outgoing transition needs an adjacent clip."
                    )
                if clip.transition_us <= 0 or clip.transition_us > min(
                    clip.duration_us, clips[i + 1].duration_us
                ):
                    raise EditError("TRANSITION_TOO_LONG", "Transition must fit both adjacent clips.")


class Editor:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.root = settings.workspace
        for folder in ["projects", "drafts", "jobs", "frames"]:
            (self.root / folder).mkdir(parents=True, exist_ok=True)

    def path(self, project_id: str) -> Path:
        return self.root / "projects" / (checked_id(project_id) + ".json")

    def load(self, project_id: str) -> Project:
        path = self.path(project_id)
        if not path.is_file():
            raise EditError("PROJECT_NOT_FOUND", "Unknown project ID.")
        return Project.model_validate(read_json(path))

    def create(self, name: str, width: int = 1080, height: int = 1920, fps: int = 30) -> dict:
        project = Project(name=name, width=width, height=height, fps=fps)
        write_json(self.path(project.id), project.model_dump())
        return self.summary(project)

    @staticmethod
    def summary(project: Project) -> dict:
        return {
            "project_id": project.id,
            "revision": project.revision,
            "name": project.name,
            "width": project.width,
            "height": project.height,
            "fps": project.fps,
            "duration": project.duration_us / 1e6,
            "track_count": len(project.tracks),
            "clip_count": sum(len(t.clips) for t in project.tracks),
        }

    def get(self, project_id: str, offset: int = 0, limit: int = 50) -> dict:
        project = self.load(project_id)
        clips = [{"track_id": t.id, **c.model_dump()} for t in project.tracks for c in t.clips]
        return {
            **self.summary(project),
            "time_unit": "integer_microseconds",
            "tracks": [
                {"track_id": t.id, "kind": t.kind, "name": t.name, "clip_count": len(t.clips)}
                for t in project.tracks
            ],
            "clips": clips[offset : offset + limit],
            "offset": offset,
            "next_offset": offset + limit if offset + limit < len(clips) else None,
        }

    def edit(self, project_id: str, expected_revision: int | None, operation) -> dict:
        with FileLock(str(self.path(project_id)) + ".lock", timeout=15):
            project = self.load(project_id)
            if expected_revision is not None and project.revision != expected_revision:
                raise EditError(
                    "REVISION_CONFLICT",
                    "Refresh the project before editing.",
                    expected_revision=expected_revision,
                    actual_revision=project.revision,
                )
            result = operation(project) or {}
            validate(project)
            project.revision += 1
            write_json(self.path(project_id), project.model_dump())
            return {**self.summary(project), **result}

    @staticmethod
    def track(project: Project, track_id: str) -> Track:
        for track in project.tracks:
            if track.id == track_id:
                return track
        raise EditError("TRACK_NOT_FOUND", "Unknown track ID.")

    @staticmethod
    def clip(project: Project, clip_id: str) -> tuple[Track, Clip]:
        for track in project.tracks:
            for clip in track.clips:
                if clip.id == clip_id:
                    return track, clip
        raise EditError("CLIP_NOT_FOUND", "Unknown clip ID.")

    def add_track(self, project_id, kind, name, expected_revision=None):
        def op(project):
            if any(t.name == name for t in project.tracks):
                raise EditError("TRACK_NAME_EXISTS", "Track names must be unique within a project.")
            track = Track(kind=kind, name=name)
            project.tracks.append(track)
            return {"track_id": track.id}

        return self.edit(project_id, expected_revision, op)

    def add_media(
        self,
        project_id,
        track_id,
        kind,
        path,
        start,
        source_in=0,
        duration=None,
        speed=1,
        expected_revision=None,
    ):
        info = probe(self.settings, self.settings.media_path(path))
        if kind == "audio":
            if not info["has_audio"]:
                raise EditError("NO_AUDIO_STREAM", "This source contains no audio.")
        elif info["kind"] != kind:
            raise EditError("MEDIA_TYPE_MISMATCH", f"Expected {kind}, got {info['kind']}.")
        source_start = us(source_in)
        if kind == "image":
            if duration is None:
                raise EditError("DURATION_REQUIRED", "Images need a timeline duration.")
            source_duration, target_duration = us(duration), us(duration)
        else:
            if info["duration_us"] is None:
                raise EditError("UNKNOWN_DURATION", "Cannot edit media with unknown duration.")
            source_duration = us(duration) if duration is not None else info["duration_us"] - source_start
            target_duration = round(source_duration / speed)
        asset = Asset.model_validate({k: info[k] for k in Asset.model_fields if k in info})
        if kind == "audio" and info["kind"] == "video":
            cache = self.root / "audio-cache"
            cache.mkdir(exist_ok=True)
            audio = cache / (asset.sha256 + ".wav")
            with FileLock(str(audio) + ".lock", timeout=120):
                if not audio.exists():
                    pending = cache / (uid() + ".wav")
                    try:
                        run(
                            [
                                self.settings.ffmpeg,
                                "-v",
                                "error",
                                "-i",
                                asset.path,
                                "-vn",
                                "-map",
                                "0:a:0",
                                "-c:a",
                                "pcm_s16le",
                                str(pending),
                            ],
                            timeout=600,
                        )
                        pending.rename(audio)
                    finally:
                        pending.unlink(missing_ok=True)
            asset.audio_path, asset.audio_sha256 = str(audio), digest(audio)
        clip = Clip(
            kind=kind,
            start_us=us(start),
            duration_us=target_duration,
            asset=asset,
            source_in_us=source_start,
            source_duration_us=source_duration,
            speed=speed,
        )

        def op(project):
            self.track(project, track_id).clips.append(clip)
            return {"clip_id": clip.id, "start": clip.start_us / 1e6, "duration": clip.duration_us / 1e6}

        return self.edit(project_id, expected_revision, op)

    def add_text(self, project_id, track_id, text, start, duration, expected_revision=None):
        if not text.strip():
            raise EditError("EMPTY_TEXT", "Text must not be empty.")
        clip = Clip(kind="text", start_us=us(start), duration_us=us(duration), text=text)

        def op(project):
            self.track(project, track_id).clips.append(clip)
            return {"clip_id": clip.id}

        return self.edit(project_id, expected_revision, op)

    def trim(self, project_id, clip_id, source_in, source_out, expected_revision=None):
        def op(project):
            _, clip = self.clip(project, clip_id)
            if clip.kind not in {"video", "audio"}:
                raise EditError("TIMED_MEDIA_REQUIRED", "Trim applies to video/audio source intervals.")
            if source_out <= source_in:
                raise EditError("INVALID_RANGE", "source_out must be greater than source_in.")
            clip.source_in_us = us(source_in)
            clip.source_duration_us = us(source_out) - clip.source_in_us
            clip.duration_us = round(clip.source_duration_us / clip.speed)
            return {"clip_id": clip_id}

        return self.edit(project_id, expected_revision, op)

    def split(self, project_id, clip_id, at, expected_revision=None):
        def op(project):
            track, clip = self.clip(project, clip_id)
            left = us(at) - clip.start_us
            if not 0 < left < clip.duration_us:
                raise EditError("INVALID_SPLIT", "at is an absolute timeline time strictly inside the clip.")
            if clip.keyframes or clip.transition or clip.fade_in_us or clip.fade_out_us or clip.animations:
                raise EditError(
                    "SPLIT_REQUIRES_PLAIN_CLIP",
                    "Clear keyframes, transition, fades and animations before splitting.",
                )
            right = copy.deepcopy(clip)
            right.id = uid()
            right.start_us = us(at)
            right.duration_us = clip.duration_us - left
            clip.duration_us = left
            if clip.kind in {"video", "audio"}:
                consumed = round(left * clip.speed)
                right.source_in_us += consumed
                right.source_duration_us -= consumed
                clip.source_duration_us = consumed
            track.clips.append(right)
            return {"left_clip_id": clip.id, "right_clip_id": right.id}

        return self.edit(project_id, expected_revision, op)

    def move(self, project_id, clip_id, start, track_id=None, expected_revision=None):
        def op(project):
            track, clip = self.clip(project, clip_id)
            if track_id and track_id != track.id:
                track.clips.remove(clip)
                self.track(project, track_id).clips.append(clip)
            clip.start_us = us(start)
            return {"clip_id": clip_id}

        return self.edit(project_id, expected_revision, op)

    def remove(self, project_id, clip_id, expected_revision=None, ripple=False):
        def op(project):
            track, clip = self.clip(project, clip_id)
            track.clips.remove(clip)
            shifted = []
            if ripple:
                for other in track.clips:
                    if other.start_us >= clip.end_us:
                        other.start_us -= clip.duration_us
                        shifted.append({"clip_id": other.id, "start": other.start_us / 1e6})
            return {"removed_clip_id": clip_id, "ripple": ripple, "shifted_clips": shifted}

        return self.edit(project_id, expected_revision, op)

    def transform(self, project_id, clip_id, transform: TransformPatch, expected_revision=None):
        def op(project):
            _, clip = self.clip(project, clip_id)
            if clip.kind not in {"video", "image", "text", "sticker"}:
                raise EditError("VISUAL_CLIP_REQUIRED", "Audio has no visual transform.")
            clip.transform = Transform.model_validate(
                clip.transform.model_dump() | transform.model_dump(exclude_none=True)
            )

        return self.edit(project_id, expected_revision, op)

    def speed(self, project_id, clip_id, speed, expected_revision=None):
        def op(project):
            _, clip = self.clip(project, clip_id)
            if clip.kind not in {"video", "audio"}:
                raise EditError("TIMED_MEDIA_REQUIRED", "Speed applies to video/audio.")
            clip.speed = speed
            clip.duration_us = round(clip.source_duration_us / speed)

        return self.edit(project_id, expected_revision, op)

    def audio(self, project_id, clip_id, volume, fade_in, fade_out, expected_revision=None):
        def op(project):
            _, clip = self.clip(project, clip_id)
            if clip.kind not in {"video", "audio"} or not clip.asset or not clip.asset.has_audio:
                raise EditError("NO_AUDIO_STREAM", "Clip has no editable audio stream.")
            clip.volume = volume
            clip.fade_in_us, clip.fade_out_us = us(fade_in), us(fade_out)

        return self.edit(project_id, expected_revision, op)

    def text(self, project_id, clip_id, text, style: TextStylePatch, expected_revision=None):
        def op(project):
            _, clip = self.clip(project, clip_id)
            if clip.kind != "text":
                raise EditError("TEXT_CLIP_REQUIRED", "This operation needs a text clip.")
            if text is not None:
                if not text.strip():
                    raise EditError("EMPTY_TEXT", "Text must not be empty.")
                clip.text = text
            clip.style = TextStyle.model_validate(
                clip.style.model_dump() | style.model_dump(exclude_none=True)
            )

        return self.edit(project_id, expected_revision, op)

    def keyframes(
        self, project_id, clip_id, property_name, points: list[KeyframePoint], expected_revision=None
    ):
        allowed = {
            "position_x",
            "position_y",
            "rotation",
            "scale_x",
            "scale_y",
            "alpha",
            "volume",
            "brightness",
            "contrast",
            "saturation",
            "uniform_scale",
        }
        if property_name not in allowed:
            raise EditError("UNSUPPORTED_PROPERTY", "Choose a supported keyframe property.")
        if len({us(p.time) for p in points}) != len(points):
            raise EditError("DUPLICATE_KEYFRAME_TIME", "Keyframe times must be unique.")
        for point in points:
            if property_name == "alpha" and not 0 <= point.value <= 1:
                raise EditError("INVALID_KEYFRAME_VALUE", "alpha must be between 0 and 1.")
            if property_name in {"scale_x", "scale_y", "uniform_scale"} and point.value <= 0:
                raise EditError("INVALID_KEYFRAME_VALUE", "Scale must be positive.")
            if property_name == "volume" and not 0 <= point.value <= 10:
                raise EditError("INVALID_KEYFRAME_VALUE", "Volume must be between 0 and 10.")

        def op(project):
            _, clip = self.clip(project, clip_id)
            if clip.kind in {"effect", "filter"}:
                raise EditError("UNSUPPORTED_PROPERTY", "Effect/filter track clips do not support keyframes.")
            if property_name in {"brightness", "contrast", "saturation"} and clip.kind not in {
                "video",
                "image",
            }:
                raise EditError("UNSUPPORTED_PROPERTY", "Color keyframes apply to video/image clips.")
            if (clip.kind == "audio" and property_name != "volume") or (
                clip.kind == "text" and property_name == "volume"
            ):
                raise EditError("UNSUPPORTED_PROPERTY", "Property is incompatible with clip kind.")
            if property_name == "volume" and (not clip.asset or not clip.asset.has_audio):
                raise EditError("NO_AUDIO_STREAM", "Clip has no audio stream.")
            if points:
                clip.keyframes[property_name] = sorted(points, key=lambda p: p.time)
            else:
                clip.keyframes.pop(property_name, None)

        return self.edit(project_id, expected_revision, op)

    def subtitles(self, project_id, track_id, path, offset=0, expected_revision=None):
        body = self.settings.media_path(path).read_text(encoding="utf-8-sig")
        if len(body) > 2_000_000:
            raise EditError("SUBTITLE_TOO_LARGE", "Use an SRT smaller than 2 MB.")
        clips = []

        def timestamp(s):
            h, m, sec, ms = map(int, re.split(r"[:,.]", s))
            if m > 59 or sec > 59:
                raise EditError("INVALID_SRT", "Invalid timestamp.")
            return ((h * 60 + m) * 60 + sec) * 1_000_000 + ms * 1000

        for block in re.split(r"\n\s*\n", body.replace("\r\n", "\n").strip()):
            lines = block.strip().splitlines()
            if not lines:
                continue
            if lines[0].isdigit():
                lines = lines[1:]
            if len(lines) < 2:
                raise EditError("INVALID_SRT", "Each SRT cue needs a time range and text.")
            match = re.fullmatch(
                r"(\d{2,}:\d{2}:\d{2}[,.]\d{3})\s+-->\s+(\d{2,}:\d{2}:\d{2}[,.]\d{3})", lines[0]
            )
            if not match or len(lines) < 2:
                raise EditError("INVALID_SRT", "Each SRT cue needs a time range and text.")
            start, end = map(timestamp, match.groups())
            clip = Clip(
                kind="text", start_us=start + us(offset), duration_us=end - start, text="\n".join(lines[1:])
            )
            clip.transform.y = -0.75
            clips.append(clip)
        if not clips:
            raise EditError("EMPTY_SUBTITLES", "No SRT cues found.")

        def op(project):
            self.track(project, track_id).clips.extend(clips)
            return {"clip_ids": [c.id for c in clips], "cue_count": len(clips)}

        return self.edit(project_id, expected_revision, op)

    def check_assets(self, project: Project):
        checked = {}
        for track in project.tracks:
            for clip in track.clips:
                if clip.asset and clip.asset.path not in checked:
                    path = self.settings.media_path(clip.asset.path)
                    checked[clip.asset.path] = digest(path)
                if clip.asset and checked[clip.asset.path] != clip.asset.sha256:
                    raise EditError(
                        "ASSET_CHANGED", "Source content changed; add the source again.", path=clip.asset.path
                    )
                if clip.asset and clip.asset.audio_path:
                    audio = Path(clip.asset.audio_path)
                    if not audio.is_file() or digest(audio) != clip.asset.audio_sha256:
                        raise EditError(
                            "DERIVED_AUDIO_CHANGED", "Extracted audio cache is missing or changed."
                        )
