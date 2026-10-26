from typing import Annotated, Literal

from pydantic import Field

from .advanced import add_resource_clip, require_kind, set_field
from .core import (
    Animation,
    Background,
    Chroma,
    Crop,
    EditError,
    Effect,
    Mask,
    Positive,
    Seconds,
    TextBackground,
    TextShadow,
)
from .resources import Category, catalog, check_resource, resolve

Revision = Annotated[int | None, Field(ge=0)]
ResourceID = Annotated[str, Field(min_length=1, max_length=256, pattern=r"^[\w.-]+$")]


def register_advanced(capability, editor):
    @capability(readonly=True)
    def list_resources(
        category: Category | None = None,
        query: str = "",
        offset: Annotated[int, Field(ge=0)] = 0,
        limit: Annotated[int, Field(ge=1, le=200)] = 50,
    ) -> dict:
        """Discover static SDK categories/names, IDs, VIP flags and normalized effect parameters. Not an online library."""
        return catalog(category, query, offset, limit)

    @capability(readonly=True)
    def check_resource_availability(
        category: Category, name: str, cache_roots: Annotated[list[str] | None, Field(max_length=10)] = None
    ) -> dict:
        """Check a catalog entry and bounded local cache name/ID matches in allowed roots. Does not certify rendering."""
        return check_resource(editor.settings, category, name, cache_roots or [])

    @capability()
    def set_text_font(
        project_id: str, clip_id: str, name: str | None, expected_revision: Revision = None
    ) -> dict:
        """Set a catalog font on a text clip; name=null restores the default font."""
        return set_field(editor, project_id, clip_id, "font", name, {"text"}, expected_revision)

    @capability()
    def set_text_effect(
        project_id: str, clip_id: str, effect_id: ResourceID | None, expected_revision: Revision = None
    ) -> dict:
        """Apply a native fancy-text effect ID inspected from a template; null removes. Resource must be available locally."""
        return set_field(
            editor, project_id, clip_id, "text_effect_id", effect_id, {"text"}, expected_revision
        )

    @capability()
    def set_text_bubble(
        project_id: str,
        clip_id: str,
        effect_id: ResourceID | None,
        resource_id: ResourceID | None = None,
        expected_revision: Revision = None,
    ) -> dict:
        """Apply a template-inspected text bubble effect/resource pair; both null removes the bubble."""
        if bool(effect_id) != bool(resource_id):
            raise EditError(
                "RESOURCE_PAIR_REQUIRED", "Supply both effect_id and resource_id, or null for both."
            )

        def op(project):
            _, clip = editor.clip(project, clip_id)
            require_kind(clip, {"text"})
            clip.bubble_effect_id, clip.bubble_resource_id = effect_id, resource_id

        return editor.edit(project_id, expected_revision, op)

    @capability()
    def set_text_background(
        project_id: str, clip_id: str, background: TextBackground | None, expected_revision: Revision = None
    ) -> dict:
        """Replace text background settings (color, rounding, dimensions, offsets); null clears."""
        return set_field(
            editor, project_id, clip_id, "text_background", background, {"text"}, expected_revision
        )

    @capability()
    def set_text_shadow(
        project_id: str, clip_id: str, shadow: TextShadow | None, expected_revision: Revision = None
    ) -> dict:
        """Replace text shadow settings; null clears."""
        return set_field(editor, project_id, clip_id, "text_shadow", shadow, {"text"}, expected_revision)

    @capability()
    def set_clip_animation(
        project_id: str,
        clip_id: str,
        category: Literal[
            "video_intro", "video_outro", "video_group", "text_intro", "text_outro", "text_loop"
        ],
        name: str | None,
        duration: Positive | None = None,
        expected_revision: Revision = None,
    ) -> dict:
        """Replace one clip animation category using exact catalog name and duration in seconds; name=null clears that category."""

        def op(project):
            _, clip = editor.clip(project, clip_id)
            require_kind(clip, {"text"} if category.startswith("text_") else {"video", "image"})
            clip.animations = [a for a in clip.animations if a.category != category]
            if name is not None:
                clip.animations.append(Animation(category=category, name=name, duration=duration))

        return editor.edit(project_id, expected_revision, op)

    @capability()
    def add_clip_effect(
        project_id: str, clip_id: str, effect: Effect, expected_revision: Revision = None
    ) -> dict:
        """Add video/character/filter or audio scene/tone/speech-to-song effect. Returns effect_id for later update/removal."""
        # IDs belong to the service; disregard caller-supplied IDs to avoid accidental reuse.
        from .core import uid

        effect = effect.model_copy(update={"id": uid()})

        def op(project):
            _, clip = editor.clip(project, clip_id)
            require_kind(clip, {"video", "image", "audio"})
            clip.effects.append(effect)
            return {"effect_id": effect.id}

        return editor.edit(project_id, expected_revision, op)

    @capability()
    def update_clip_effect(
        project_id: str, clip_id: str, effect_id: str, effect: Effect, expected_revision: Revision = None
    ) -> dict:
        """Replace an effect's category/name/params/intensity while preserving its ID; also edits effect/filter track clips."""

        def op(project):
            _, clip = editor.clip(project, clip_id)
            for i, current in enumerate(clip.effects):
                if current.id == effect_id:
                    clip.effects[i] = effect.model_copy(update={"id": effect_id})
                    return {"effect_id": effect_id}
            raise EditError("EFFECT_NOT_FOUND", "Unknown effect ID on this clip.")

        return editor.edit(project_id, expected_revision, op)

    @capability()
    def remove_clip_effect(
        project_id: str, clip_id: str, effect_id: str, expected_revision: Revision = None
    ) -> dict:
        """Remove an attached effect by ID. For independent effect/filter clips use remove_clip."""

        def op(project):
            _, clip = editor.clip(project, clip_id)
            require_kind(clip, {"video", "image", "audio"})
            if not any(e.id == effect_id for e in clip.effects):
                raise EditError("EFFECT_NOT_FOUND", "Unknown effect ID on this clip.")
            clip.effects = [e for e in clip.effects if e.id != effect_id]

        return editor.edit(project_id, expected_revision, op)

    @capability()
    def set_clip_mask(
        project_id: str, clip_id: str, mask: Mask | None, expected_revision: Revision = None
    ) -> dict:
        """Replace a native mask; null clears. center_x/y are SOURCE PIXELS; size/rect_width are normalized; feather 0..100."""
        return set_field(editor, project_id, clip_id, "mask", mask, {"video", "image"}, expected_revision)

    @capability()
    def set_clip_chroma(
        project_id: str, clip_id: str, chroma: Chroma | None, expected_revision: Revision = None
    ) -> dict:
        """Replace color-key settings; null clears. Key color is #RRGGBBAA. This is not AI/person segmentation."""
        return set_field(editor, project_id, clip_id, "chroma", chroma, {"video", "image"}, expected_revision)

    @capability()
    def set_clip_mix_mode(
        project_id: str, clip_id: str, name: str | None, expected_revision: Revision = None
    ) -> dict:
        """Set a catalog blend mode for video/image; null clears."""
        return set_field(editor, project_id, clip_id, "mix_mode", name, {"video", "image"}, expected_revision)

    @capability()
    def set_clip_background(
        project_id: str, clip_id: str, background: Background | None, expected_revision: Revision = None
    ) -> dict:
        """Set blurred/color canvas fill for a bottom video track clip; null clears. Color is #RRGGBBAA."""
        return set_field(
            editor, project_id, clip_id, "background", background, {"video", "image"}, expected_revision
        )

    @capability()
    def set_clip_crop(
        project_id: str, clip_id: str, crop: Crop | None, expected_revision: Revision = None
    ) -> dict:
        """Replace source rectangle crop; left/top/right/bottom are 0..1, origin top-left. null restores full source."""
        return set_field(editor, project_id, clip_id, "crop", crop, {"video", "image"}, expected_revision)

    @capability()
    def add_sticker_clip(
        project_id: str,
        track_id: str,
        resource_id: ResourceID,
        duration: Positive,
        start: Seconds = 0,
        expected_revision: Revision = None,
    ) -> dict:
        """Add a native sticker by template-inspected resource ID to a sticker track; resource availability requires native verification."""
        return add_resource_clip(
            editor,
            project_id,
            track_id,
            "sticker",
            start,
            duration,
            expected_revision,
            resource_id=resource_id,
        )

    @capability()
    def add_effect_clip(
        project_id: str,
        track_id: str,
        effect: Effect,
        duration: Positive,
        start: Seconds = 0,
        expected_revision: Revision = None,
    ) -> dict:
        """Add an independent global effect/filter clip. Use an effect track for video/character effects or filter track for filters."""
        from .core import uid

        resolve(effect.category, effect.name)
        return add_resource_clip(
            editor,
            project_id,
            track_id,
            "filter" if effect.category == "filter" else "effect",
            start,
            duration,
            expected_revision,
            effects=[effect.model_copy(update={"id": uid()})],
        )
