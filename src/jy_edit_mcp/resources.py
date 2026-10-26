"""SDK resource discovery. A catalog entry is never proof of native availability."""

from pathlib import Path
from typing import Literal

from .core import EditError

Category = Literal[
    "font",
    "video_intro",
    "video_outro",
    "video_group",
    "text_intro",
    "text_outro",
    "text_loop",
    "video_effect",
    "character_effect",
    "filter",
    "mask",
    "mix_mode",
    "audio_scene",
    "tone",
    "speech_to_song",
    "transition",
]
ENUMS = {
    "font": "FontType",
    "video_intro": "IntroType",
    "video_outro": "OutroType",
    "video_group": "GroupAnimationType",
    "text_intro": "TextIntro",
    "text_outro": "TextOutro",
    "text_loop": "TextLoopAnim",
    "video_effect": "VideoSceneEffectType",
    "character_effect": "VideoCharacterEffectType",
    "filter": "FilterType",
    "mask": "MaskType",
    "mix_mode": "MixModeType",
    "audio_scene": "AudioSceneEffectType",
    "tone": "ToneEffectType",
    "speech_to_song": "SpeechToSongType",
    "transition": "TransitionType",
}


def resolve(category, name):
    import pyJianYingDraft as d

    if category not in ENUMS:
        raise EditError("UNKNOWN_RESOURCE_CATEGORY", "Use a category returned by list_resources.")
    try:
        return getattr(d, ENUMS[category])[name]
    except KeyError as exc:
        raise EditError(
            "RESOURCE_NOT_FOUND", "Use the exact catalog name.", category=category, name=name
        ) from exc


def describe(category, item):
    meta = item.value
    result = {
        "category": category,
        "name": item.name,
        "title": getattr(meta, "title", getattr(meta, "name", item.name)),
    }
    for key in ["resource_id", "effect_id", "md5", "is_vip", "resource_type"]:
        if hasattr(meta, key):
            result[key] = getattr(meta, key)
    if hasattr(meta, "duration"):
        result["default_duration"] = meta.duration / 1e6
    result["params"] = [
        {
            "index": i,
            "name": p.name,
            "default_native": p.default_value,
            "native_min": p.min_value,
            "native_max": p.max_value,
            "input_min": 0,
            "input_max": 100,
        }
        for i, p in enumerate(getattr(meta, "params", []))
    ]
    result["native_verified"] = False
    return result


def catalog(category, query="", offset=0, limit=50):
    import pyJianYingDraft as d

    if category is None:
        return {
            "categories": list(ENUMS),
            "note": "Static SDK catalog; not the complete online Jianying library.",
        }
    rows = [describe(category, item) for item in getattr(d, ENUMS[category])]
    rows = [r for r in rows if query.casefold() in (r["name"] + " " + r["title"]).casefold()]
    return {
        "resources": rows[offset : offset + limit],
        "total": len(rows),
        "offset": offset,
        "next_offset": offset + limit if offset + limit < len(rows) else None,
        "availability": "unverified",
        "source": "pinned_sdk_catalog",
    }


def check_resource(settings, category, name, cache_roots):
    item = describe(category, resolve(category, name))
    tokens = [str(item[k]).lower() for k in ["resource_id", "effect_id", "md5"] if item.get(k)]
    roots = []
    for value in cache_roots:
        root = Path(value).expanduser().resolve(strict=True)
        allowed = (*settings.media_roots, *((settings.jy_dir,) if settings.jy_dir else ()))
        if not root.is_dir() or not any(root.is_relative_to(p) for p in allowed):
            raise EditError(
                "PATH_OUTSIDE_MEDIA_ROOTS", "Cache roots must be directories under media roots or Jy install."
            )
        roots.append(root)
    matches, inspected, truncated = [], 0, False
    for root in roots:
        # Bound traversal, never follow directory junctions/symlinks or read private file contents.
        stack = [root]
        while stack and inspected < 20000 and len(matches) < 100:
            current = stack.pop()
            for path in current.iterdir():
                inspected += 1
                if inspected > 20000:
                    break
                if path.is_symlink() or path.is_junction():
                    continue
                if any(token in path.name.lower() for token in tokens):
                    matches.append(str(path))
                if path.is_dir():
                    stack.append(path)
        truncated |= bool(stack) or inspected >= 20000 or len(matches) >= 100
    return {
        "resource": item,
        "cache_candidates": matches[:100],
        "inspected_entries": inspected,
        "truncated": truncated,
        "cache_status": "candidate_found" if matches else "not_found" if roots else "not_checked",
        "native_verified": False,
        "note": "Names/IDs in cache are hints only. No downloads, entitlement checks or rendering were performed.",
    }
