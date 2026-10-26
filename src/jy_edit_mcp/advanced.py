"""Advanced clip state and compilation shared by atomic MCP operations."""

from .core import Clip, EditError, us
from .resources import resolve


def require_kind(clip, kinds):
    if clip.kind not in kinds:
        raise EditError(
            "CLIP_TYPE_MISMATCH", "Operation is incompatible with this clip kind.", allowed=list(kinds)
        )


def validate_effect(effect):
    item = resolve(effect.category, effect.name)
    if len(effect.params) > len(getattr(item.value, "params", [])):
        raise EditError("INVALID_EFFECT_PARAMS", "Too many parameters; consult list_resources.")
    if effect.category == "filter" and effect.params:
        raise EditError("INVALID_EFFECT_PARAMS", "Filters accept intensity, not params.")


def validate_advanced(clip):
    if len({e.id for e in clip.effects}) != len(clip.effects):
        raise EditError("DUPLICATE_ID", "Effect IDs must be unique on a clip.")
    if "uniform_scale" in clip.keyframes and ({"scale_x", "scale_y"} & clip.keyframes.keys()):
        raise EditError("KEYFRAME_CONFLICT", "Choose uniform_scale or separate scale_x/scale_y keyframes.")
    if clip.font:
        require_kind(clip, {"text"})
        resolve("font", clip.font)
    if clip.mask:
        require_kind(clip, {"video", "image"})
        resolve("mask", clip.mask.name)
        if clip.mask.name != "矩形" and (
            clip.mask.rect_width is not None or clip.mask.round_corner is not None
        ):
            raise EditError("INVALID_MASK", "rect_width and round_corner only apply to the rectangular mask.")
    if clip.crop and (clip.crop.left >= clip.crop.right or clip.crop.top >= clip.crop.bottom):
        raise EditError("INVALID_CROP", "left/top must be smaller than right/bottom.")
    if clip.mix_mode:
        resolve("mix_mode", clip.mix_mode)
    if clip.kind in {"effect", "filter"} and len(clip.effects) != 1:
        raise EditError("EFFECT_REQUIRED", "An effect/filter track clip needs exactly one effect.")
    if clip.kind == "sticker" and not clip.resource_id:
        raise EditError("RESOURCE_REQUIRED", "Sticker needs a resource_id.")
    categories = set()
    for animation in clip.animations:
        require_kind(clip, {"text"} if animation.category.startswith("text_") else {"video", "image"})
        if animation.category in categories:
            raise EditError("DUPLICATE_ANIMATION", "Only one animation per category is supported.")
        categories.add(animation.category)
        item = resolve(animation.category, animation.name)
        duration = (
            us(animation.duration)
            if animation.duration
            else (
                clip.duration_us
                if animation.category in {"video_group", "text_loop"}
                else item.value.duration
            )
        )
        if duration > clip.duration_us:
            raise EditError("ANIMATION_TOO_LONG", "Animation must fit inside the clip; specify duration.")
    if "video_group" in categories and len(categories) > 1:
        raise EditError("ANIMATION_CONFLICT", "Group animation cannot be combined with video intro/outro.")
    audio_categories = set()
    for effect in clip.effects:
        validate_effect(effect)
        if effect.category in {"audio_scene", "tone", "speech_to_song"}:
            require_kind(clip, {"audio"})
            if effect.category in audio_categories:
                raise EditError("DUPLICATE_AUDIO_EFFECT", "Only one audio effect per category is supported.")
            audio_categories.add(effect.category)
        else:
            require_kind(clip, {"video", "image", "effect", "filter"})
            if clip.kind == "filter" and effect.category != "filter":
                raise EditError("CLIP_TYPE_MISMATCH", "Filter track requires a filter resource.")
            if clip.kind == "effect" and effect.category not in {"video_effect", "character_effect"}:
                raise EditError("CLIP_TYPE_MISMATCH", "Effect track requires a video/character effect.")


def apply_advanced(d, segment, clip):
    for animation in clip.animations:
        duration = us(animation.duration) if animation.duration is not None else None
        if animation.category == "text_loop" and duration is None:
            duration = clip.duration_us
        segment.add_animation(resolve(animation.category, animation.name), duration=duration)
    if clip.kind not in {"effect", "filter"}:
        for effect in clip.effects:
            if effect.category == "filter":
                segment.add_filter(resolve("filter", effect.name), effect.intensity)
            else:
                segment.add_effect(resolve(effect.category, effect.name), params=effect.params)
    if clip.kind == "text":
        if clip.text_effect_id:
            segment.add_effect(clip.text_effect_id)
        if clip.bubble_effect_id:
            segment.add_bubble(clip.bubble_effect_id, clip.bubble_resource_id)
    if clip.mask:
        segment.add_mask(resolve("mask", clip.mask.name), **clip.mask.model_dump(exclude={"name"}))
    if clip.chroma:
        segment.add_chroma(**clip.chroma.model_dump())
    if clip.mix_mode:
        segment.set_mix_mode(resolve("mix_mode", clip.mix_mode))
    if clip.background:
        segment.add_background_filling(**clip.background.model_dump())
    return segment


def set_field(editor, project_id, clip_id, field, value, kinds, revision):
    def op(project):
        _, clip = editor.clip(project, clip_id)
        require_kind(clip, kinds)
        setattr(clip, field, value)
        return {"clip_id": clip_id}

    return editor.edit(project_id, revision, op)


def add_resource_clip(editor, project_id, track_id, kind, start, duration, revision, **fields):
    clip = Clip(kind=kind, start_us=us(start), duration_us=us(duration), **fields)

    def op(project):
        editor.track(project, track_id).clips.append(clip)
        return {"clip_id": clip.id}

    return editor.edit(project_id, revision, op)
