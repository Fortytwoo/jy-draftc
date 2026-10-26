"""Copy-on-write local template operations. Never save back to the imported file."""

import json
import tempfile
from pathlib import Path

from filelock import FileLock

from .core import EditError, checked_id, digest, read_json, uid, write_json


def input_file(editor, value):
    path = Path(value).expanduser()
    if not path.is_absolute():
        path = editor.settings.media_roots[0] / path
    path = path.resolve(strict=True)
    if path.is_file() and any(
        path.is_relative_to(editor.root / folder) for folder in ["drafts", "conversions"]
    ):
        return path
    return editor.settings.media_path(value)


def assets(editor, content):
    result = {}
    for bucket in ["videos", "audios"]:
        for material in content.get("materials", {}).get(bucket, []):
            if not material.get("path"):
                continue
            path = editor.settings.media_path(material["path"])
            material["path"] = str(path)
            result[str(path)] = digest(path)
    return result


def check_assets(source_hashes):
    for value, fingerprint in source_hashes.items():
        path = Path(value)
        if not path.is_file() or digest(path) != fingerprint:
            raise EditError("ASSET_CHANGED", "Template source media changed or disappeared.", path=value)


def script_from_content(editor, content):
    import pyJianYingDraft as d

    # The SDK accepts a path; use our own disposable file, never the user's draft.
    with tempfile.TemporaryDirectory(prefix="template-", dir=editor.root) as temp:
        path = Path(temp) / "draft_content.json"
        write_json(path, content)
        return d.ScriptFile._load_template(str(path))


class Templates:
    def __init__(self, editor):
        self.editor = editor
        self.root = editor.root / "templates"
        self.root.mkdir(exist_ok=True)

    def path(self, template_id):
        return self.root / (checked_id(template_id) + ".json")

    def load(self, template_id):
        path = self.path(template_id)
        if not path.is_file():
            raise EditError("TEMPLATE_NOT_FOUND", "Use an ID returned by import_local_template.")
        return read_json(path)

    def import_file(self, path, name):
        source = input_file(self.editor, path)
        try:
            content = read_json(source)
        except (UnicodeError, json.JSONDecodeError) as exc:
            raise EditError(
                "PLAIN_DRAFT_REQUIRED",
                "Decrypt the draft to a workspace copy with convert_local_draft first.",
            ) from exc
        if (
            not isinstance(content, dict)
            or not isinstance(content.get("tracks"), list)
            or "canvas_config" not in content
        ):
            raise EditError("INVALID_TEMPLATE", "Input must be a Jianying draft_content JSON object.")
        fingerprints = assets(self.editor, content)
        script_from_content(self.editor, content)  # Fail before committing unsupported structures.
        template_id = uid()
        state = {
            "template_id": template_id,
            "name": name,
            "revision": 0,
            "content": content,
            "source_path": str(source),
            "source_sha256": digest(source),
            "source_hashes": fingerprints,
        }
        write_json(self.path(template_id), state)
        return self.inspect(template_id)

    def inspect(self, template_id, offset=0, limit=50):
        state = self.load(template_id)
        content = state["content"]
        rows = []
        for track in content.get("tracks", []):
            for segment in track.get("segments", []):
                rows.append(
                    {
                        "track_id": track["id"],
                        "segment_id": segment["id"],
                        "material_id": segment.get("material_id"),
                        "target_timerange": segment.get("target_timerange"),
                        "source_timerange": segment.get("source_timerange"),
                        "speed": segment.get("speed", 1),
                    }
                )
        return {
            "template_id": template_id,
            "name": state["name"],
            "revision": state["revision"],
            "time_unit": "integer_microseconds",
            "canvas": content["canvas_config"],
            "fps": content.get("fps", 30),
            "tracks": [
                {
                    "track_id": t["id"],
                    "name": t.get("name"),
                    "kind": t["type"],
                    "segment_count": len(t.get("segments", [])),
                }
                for t in content["tracks"]
            ],
            "segments": rows[offset : offset + limit],
            "next_offset": offset + limit if offset + limit < len(rows) else None,
            "source_media_count": len(state["source_hashes"]),
            "native_verified": False,
        }

    def mutate(self, template_id, revision, operation):
        with FileLock(str(self.path(template_id)) + ".lock", timeout=15):
            state = self.load(template_id)
            if revision is not None and state["revision"] != revision:
                raise EditError(
                    "REVISION_CONFLICT",
                    "Refresh the template before editing.",
                    actual_revision=state["revision"],
                )
            check_assets(state["source_hashes"])
            script = script_from_content(self.editor, state["content"])
            result = operation(script) or {}
            state["content"] = json.loads(script.dumps())
            state["content"]["duration"] = max(
                (
                    s["target_timerange"]["start"] + s["target_timerange"]["duration"]
                    for t in state["content"]["tracks"]
                    for s in t.get("segments", [])
                    if s.get("target_timerange")
                ),
                default=0,
            )
            state["source_hashes"] = assets(self.editor, state["content"])
            state["revision"] += 1
            write_json(self.path(template_id), state)
            return {"template_id": template_id, "revision": state["revision"], **result}

    @staticmethod
    def select(script, track_id, segment_id=None):
        for track in script.imported_tracks:
            if track.track_id == track_id:
                if segment_id is None:
                    return track
                if not hasattr(track, "segments"):
                    raise EditError(
                        "UNSUPPORTED_TRACK", "Only video/audio/text template tracks can be modified."
                    )
                for i, segment in enumerate(track.segments):
                    if segment.raw_data["id"] == segment_id:
                        return track, i
                raise EditError("SEGMENT_NOT_FOUND", "Unknown segment ID on this template track.")
        raise EditError("TRACK_NOT_FOUND", "Unknown template track ID.")

    def resources(self, template_id, offset, limit):
        state = self.load(template_id)
        material = state["content"].get("materials", {})
        rows = []
        for bucket in [
            "stickers",
            "effects",
            "fonts",
            "text_templates",
            "video_effects",
            "filters",
            "material_animations",
        ]:
            for item in material.get(bucket, []):
                rows.append(
                    {
                        "bucket": bucket,
                        **{
                            k: item[k]
                            for k in ["id", "type", "name", "resource_id", "effect_id", "text_info_resources"]
                            if k in item
                        },
                    }
                )
        for text in material.get("texts", []):
            try:
                content = json.loads(text.get("content", "{}"))
            except (TypeError, json.JSONDecodeError):
                continue
            for style in content.get("styles", []):
                for key in ["font", "effectStyle"]:
                    if key in style:
                        rows.append({"bucket": key, "text_material_id": text["id"], **style[key]})
        return {
            "template_id": template_id,
            "revision": state["revision"],
            "resources": rows[offset : offset + limit],
            "total": len(rows),
            "next_offset": offset + limit if offset + limit < len(rows) else None,
            "native_verified": False,
        }

    def save(self, template_id, revision):
        with FileLock(str(self.path(template_id)) + ".lock", timeout=15):
            state = self.load(template_id)
            if revision is not None and state["revision"] != revision:
                raise EditError(
                    "REVISION_CONFLICT",
                    "Refresh the template before saving.",
                    actual_revision=state["revision"],
                )
            check_assets(state["source_hashes"])
            content = state["content"]
            draft_id = uid()
            directory = self.editor.root / "drafts" / draft_id
            directory.mkdir()
            content = dict(content, id=draft_id)
            write_json(directory / "draft_content.json", content)
            from pyJianYingDraft import assets as sdk_assets

            meta = read_json(Path(sdk_assets.get_asset_path("DRAFT_META_TEMPLATE")))
            meta.update(
                draft_id=draft_id,
                draft_name=state["name"],
                draft_fold_path=str(directory),
                tm_duration=content.get("duration", 0),
            )
            write_json(directory / "draft_meta_info.json", meta)
            manifest = {
                "mode": "template",
                "draft_id": draft_id,
                "project_id": None,
                "template_id": template_id,
                "revision": state["revision"],
                "duration_us": content["duration"],
                "width": content["canvas_config"]["width"],
                "height": content["canvas_config"]["height"],
                "fps": content.get("fps", 30),
                "source_hashes": state["source_hashes"],
                "content_sha256": digest(directory / "draft_content.json"),
                "warnings": ["Imported template resources and effects require native/visual verification."],
            }
            write_json(directory / "manifest.json", manifest)
            return {
                "template_id": template_id,
                "revision": state["revision"],
                "draft_id": draft_id,
                "draft_path": str(directory),
                "content_path": str(directory / "draft_content.json"),
                "validation": {"generated": True, "opened_in_jianying": False, "exported": False},
            }
