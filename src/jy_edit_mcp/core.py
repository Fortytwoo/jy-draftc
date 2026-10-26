from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Annotated, Literal

from dotenv import dotenv_values
from pydantic import BaseModel, ConfigDict, Field

Seconds = Annotated[float, Field(ge=0, allow_inf_nan=False)]
Positive = Annotated[float, Field(gt=0, allow_inf_nan=False)]
Kind = Literal["video", "image", "audio", "text", "sticker", "effect", "filter"]
TrackKind = Literal["video", "audio", "text", "sticker", "effect", "filter"]


class EditError(Exception):
    def __init__(self, code: str, message: str, **details):
        super().__init__(message)
        self.code, self.details = code, details


def uid() -> str:
    return uuid.uuid4().hex


def us(seconds: float) -> int:
    return round(seconds * 1_000_000)


def checked_id(value: str) -> str:
    if not re.fullmatch(r"[0-9a-f]{32}", value):
        raise EditError("INVALID_ID", "Use an ID returned by this service.")
    return value


def digest(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def write_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + "." + uid() + ".tmp")
    try:
        temp.write_text(json.dumps(data, ensure_ascii=False, indent=2, allow_nan=False), encoding="utf-8")
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)


def read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def run(args: list[str], timeout: int = 45) -> subprocess.CompletedProcess:
    try:
        result = subprocess.run(
            args,
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise EditError("PROCESS_FAILED", str(exc)) from exc
    if result.returncode:
        raise EditError(
            "PROCESS_FAILED", result.stderr[-2000:] or result.stdout[-2000:], exit_code=result.returncode
        )
    return result


@dataclass(frozen=True)
class Settings:
    workspace: Path
    media_roots: tuple[Path, ...]
    ffmpeg: str
    ffprobe: str
    native_exe: Path | None = None
    jy_dir: Path | None = None
    lyra_dir: Path | None = None
    native_draft_root: Path | None = None

    @classmethod
    def from_env(cls):
        cwd = Path.cwd().resolve()
        exe = os.environ.get("JY_DRAFTC_EXE")
        if not exe and (cwd / "build/jy-draftc.exe").is_file():
            exe = str(cwd / "build/jy-draftc.exe")
        native = Path(exe).expanduser().resolve() if exe else None
        values = dotenv_values(native.parent / ".env") if native else {}
        jy = os.environ.get("JY_INSTALL_DIR") or values.get("JY_INSTALL_DIR")
        roots = json.loads(os.environ.get("JY_EDIT_MEDIA_ROOTS", json.dumps([str(cwd)])))
        if not isinstance(roots, list) or not roots or not all(isinstance(x, str) for x in roots):
            raise ValueError("JY_EDIT_MEDIA_ROOTS must be a non-empty JSON array of directories")
        return cls(
            Path(os.environ.get("JY_EDIT_WORKSPACE", str(cwd / ".jy-edit-workspace"))).expanduser().resolve(),
            tuple(Path(x).expanduser().resolve(strict=True) for x in roots),
            os.environ.get("JY_EDIT_FFMPEG", shutil.which("ffmpeg") or "ffmpeg"),
            os.environ.get("JY_EDIT_FFPROBE", shutil.which("ffprobe") or "ffprobe"),
            native,
            Path(jy).expanduser().resolve() if jy else None,
            Path(os.environ["JY_LYRA_INSTALL_DIR"]).expanduser().resolve()
            if os.environ.get("JY_LYRA_INSTALL_DIR")
            else None,
            Path(os.environ["JY_EDIT_NATIVE_DRAFT_ROOT"]).expanduser().resolve()
            if os.environ.get("JY_EDIT_NATIVE_DRAFT_ROOT")
            else None,
        )

    def media_path(self, value: str) -> Path:
        path = Path(value).expanduser()
        if not path.is_absolute():
            path = self.media_roots[0] / path
        try:
            path = path.resolve(strict=True)
        except OSError as exc:
            raise EditError("MEDIA_NOT_FOUND", str(exc)) from exc
        if not path.is_file() or not any(path.is_relative_to(root) for root in self.media_roots):
            raise EditError(
                "PATH_OUTSIDE_MEDIA_ROOTS", "Media must be a file inside a configured media root."
            )
        return path


class Model(BaseModel):
    model_config = ConfigDict(extra="forbid", validate_assignment=True, allow_inf_nan=False)


class Transform(Model):
    x: float = Field(default=0, ge=-10, le=10)
    y: float = Field(default=0, ge=-10, le=10)
    scale_x: float = Field(default=1, gt=0, le=100)
    scale_y: float = Field(default=1, gt=0, le=100)
    rotation: float = Field(default=0, ge=-3600, le=3600)
    opacity: float = Field(default=1, ge=0, le=1)
    flip_horizontal: bool = False
    flip_vertical: bool = False
    fit: Literal["contain", "cover"] = "contain"


class TextStyle(Model):
    size: float = Field(default=8, gt=0, le=200)
    color: str = Field(default="#FFFFFF", pattern=r"^#[0-9a-fA-F]{6}$")
    bold: bool = False
    italic: bool = False
    align: Literal[0, 1, 2] = 1
    border_width: float = Field(default=0, ge=0, le=100)
    border_color: str = Field(default="#000000", pattern=r"^#[0-9a-fA-F]{6}$")
    underline: bool = False
    vertical: bool = False
    alpha: float = Field(default=1, ge=0, le=1)
    border_alpha: float = Field(default=1, ge=0, le=1)
    letter_spacing: int = Field(default=0, ge=-100, le=100)
    line_spacing: int = Field(default=0, ge=-100, le=100)
    auto_wrapping: bool = True
    max_line_width: float = Field(default=0.82, gt=0, le=1)


class TransformPatch(Model):
    x: float | None = Field(default=None, ge=-10, le=10)
    y: float | None = Field(default=None, ge=-10, le=10)
    scale_x: float | None = Field(default=None, gt=0, le=100)
    scale_y: float | None = Field(default=None, gt=0, le=100)
    rotation: float | None = Field(default=None, ge=-3600, le=3600)
    opacity: float | None = Field(default=None, ge=0, le=1)
    flip_horizontal: bool | None = None
    flip_vertical: bool | None = None
    fit: Literal["contain", "cover"] | None = None


class TextStylePatch(Model):
    size: float | None = Field(default=None, gt=0, le=200)
    color: str | None = Field(default=None, pattern=r"^#[0-9a-fA-F]{6}$")
    bold: bool | None = None
    italic: bool | None = None
    align: Literal[0, 1, 2] | None = None
    border_width: float | None = Field(default=None, ge=0, le=100)
    border_color: str | None = Field(default=None, pattern=r"^#[0-9a-fA-F]{6}$")
    underline: bool | None = None
    vertical: bool | None = None
    alpha: float | None = Field(default=None, ge=0, le=1)
    border_alpha: float | None = Field(default=None, ge=0, le=1)
    letter_spacing: int | None = Field(default=None, ge=-100, le=100)
    line_spacing: int | None = Field(default=None, ge=-100, le=100)
    auto_wrapping: bool | None = None
    max_line_width: float | None = Field(default=None, gt=0, le=1)


class TextBackground(Model):
    color: str = Field(pattern=r"^#[0-9a-fA-F]{6}$")
    style: Literal[1, 2] = 1
    alpha: float = Field(default=1, ge=0, le=1)
    round_radius: float = Field(default=0, ge=0, le=1)
    height: float = Field(default=0.14, ge=0, le=1)
    width: float = Field(default=0.14, ge=0, le=1)
    horizontal_offset: float = Field(default=0.5, ge=0, le=1)
    vertical_offset: float = Field(default=0.5, ge=0, le=1)


class TextShadow(Model):
    color: str = Field(default="#000000", pattern=r"^#[0-9a-fA-F]{6}$")
    alpha: float = Field(default=0.9, ge=0, le=1)
    diffuse: float = Field(default=15, ge=0, le=100)
    distance: float = Field(default=5, ge=0, le=100)
    angle: float = Field(default=-45, ge=-180, le=180)


class Animation(Model):
    category: Literal["video_intro", "video_outro", "video_group", "text_intro", "text_outro", "text_loop"]
    name: str
    duration: Positive | None = None


class Effect(Model):
    id: str = Field(default_factory=uid)
    category: Literal["video_effect", "character_effect", "filter", "audio_scene", "tone", "speech_to_song"]
    name: str
    params: list[Annotated[float | None, Field(ge=0, le=100)]] = Field(default_factory=list, max_length=50)
    intensity: float = Field(default=100, ge=0, le=100)


class Mask(Model):
    name: str
    center_x: float = 0
    center_y: float = 0
    size: float = Field(default=0.5, gt=0, le=10)
    rotation: float = 0
    feather: float = Field(default=0, ge=0, le=100)
    invert: bool = False
    rect_width: float | None = Field(default=None, gt=0, le=10)
    round_corner: float | None = Field(default=None, ge=0, le=100)


class Chroma(Model):
    color: str = Field(pattern=r"^#[0-9a-fA-F]{8}$")
    intensity: float = Field(default=20, ge=0, le=100)
    shadow: float = Field(default=0, ge=0, le=100)
    edge_smooth: float = Field(default=0, ge=0, le=100)
    spill: float = Field(default=0, ge=0, le=100)


class Background(Model):
    fill_type: Literal["blur", "color"]
    blur: float = Field(default=0.0625, ge=0, le=1)
    color: str = Field(default="#00000000", pattern=r"^#[0-9a-fA-F]{8}$")


class Crop(Model):
    left: float = Field(default=0, ge=0, lt=1)
    top: float = Field(default=0, ge=0, lt=1)
    right: float = Field(default=1, gt=0, le=1)
    bottom: float = Field(default=1, gt=0, le=1)


class ExportOptions(Model):
    width: int | None = Field(default=None, ge=16, le=7680, multiple_of=2)
    height: int | None = Field(default=None, ge=16, le=7680, multiple_of=2)
    fps: Literal[24, 25, 30, 50, 60] | None = None
    hard_encode: Literal[0, 1] | None = None
    quality: int | None = Field(
        default=None,
        ge=0,
        le=2147483647,
        description="Raw engine numeric option; 0 is default. Other values need version-specific verification.",
    )
    color_space: int | None = Field(
        default=None,
        ge=0,
        le=2147483647,
        description="Raw engine numeric option; 0 is default. Does not certify HDR/color correctness.",
    )
    mp4: int | None = Field(
        default=None,
        ge=0,
        le=2147483647,
        description="Raw engine numeric option; 0 is default. Other values need version-specific verification.",
    )


class KeyframePoint(Model):
    time: Seconds
    value: float


class Asset(Model):
    path: str
    sha256: str
    duration_us: int | None
    width: int = 0
    height: int = 0
    has_audio: bool = False
    audio_path: str | None = None
    audio_sha256: str | None = None


class Clip(Model):
    id: str = Field(default_factory=uid)
    kind: Kind
    start_us: int = Field(ge=0)
    duration_us: int = Field(gt=0)
    source_in_us: int = Field(default=0, ge=0)
    source_duration_us: int = Field(default=0, ge=0)
    speed: float = Field(default=1, gt=0, le=100)
    asset: Asset | None = None
    text: str = ""
    transform: Transform = Field(default_factory=Transform)
    style: TextStyle = Field(default_factory=TextStyle)
    volume: float = Field(default=1, ge=0, le=10)
    fade_in_us: int = Field(default=0, ge=0)
    fade_out_us: int = Field(default=0, ge=0)
    transition: str | None = None
    transition_us: int = 0
    keyframes: dict[str, list[KeyframePoint]] = Field(default_factory=dict)
    font: str | None = None
    text_effect_id: str | None = None
    bubble_effect_id: str | None = None
    bubble_resource_id: str | None = None
    text_background: TextBackground | None = None
    text_shadow: TextShadow | None = None
    animations: list[Animation] = Field(default_factory=list)
    effects: list[Effect] = Field(default_factory=list)
    mask: Mask | None = None
    chroma: Chroma | None = None
    background: Background | None = None
    mix_mode: str | None = None
    crop: Crop | None = None
    resource_id: str | None = None

    @property
    def end_us(self):
        return self.start_us + self.duration_us


class Track(Model):
    id: str = Field(default_factory=uid)
    kind: TrackKind
    name: str = Field(min_length=1, max_length=120)
    clips: list[Clip] = Field(default_factory=list)


class Project(Model):
    schema_version: Literal[1] = 1
    id: str = Field(default_factory=uid)
    name: str = Field(min_length=1, max_length=120)
    width: int = Field(default=1080, ge=16, le=7680, multiple_of=2)
    height: int = Field(default=1920, ge=16, le=7680, multiple_of=2)
    fps: Literal[24, 25, 30, 50, 60] = 30
    revision: int = 0
    tracks: list[Track] = Field(default_factory=list)

    @property
    def duration_us(self):
        return max((c.end_us for t in self.tracks for c in t.clips), default=0)


def probe(settings: Settings, path: Path, with_hash: bool = True) -> dict:
    data = json.loads(
        run(
            [settings.ffprobe, "-v", "error", "-show_format", "-show_streams", "-of", "json", str(path)]
        ).stdout
    )
    video = next((s for s in data["streams"] if s["codec_type"] == "video"), None)
    audio = next((s for s in data["streams"] if s["codec_type"] == "audio"), None)
    is_image = path.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp", ".bmp"}
    duration = data.get("format", {}).get("duration") or (video or audio or {}).get("duration")
    rotation = next(
        (int(s.get("rotation", 0)) for s in (video or {}).get("side_data_list", []) if "rotation" in s), 0
    )
    width, height = int((video or {}).get("width", 0)), int((video or {}).get("height", 0))
    if abs(rotation) % 180 == 90:
        width, height = height, width
    return {
        "path": str(path),
        "kind": "image" if is_image else "video" if video else "audio",
        "duration_us": us(float(duration)) if duration and not is_image else None,
        "width": width,
        "height": height,
        "has_audio": bool(audio),
        "rotation": rotation,
        "frame_rate": (video or {}).get("avg_frame_rate"),
        "video_codec": (video or {}).get("codec_name"),
        "audio_codec": (audio or {}).get("codec_name"),
        "sha256": digest(path) if with_hash else None,
    }
