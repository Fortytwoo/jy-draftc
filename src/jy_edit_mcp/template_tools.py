import re
import shutil
from pathlib import Path
from typing import Annotated, Literal

from pydantic import Field

from .core import EditError, ExportOptions, Positive, Seconds, digest, read_json, run, uid, write_json
from .templates import Templates, input_file, script_from_content

Revision = Annotated[int | None, Field(ge=0)]
Limit = Annotated[int, Field(ge=1, le=200)]
Offset = Annotated[int, Field(ge=0)]


def native(editor):
    settings = editor.settings
    if not settings.native_exe or not settings.native_exe.is_file():
        raise EditError("NATIVE_UNAVAILABLE", "Configure JY_DRAFTC_EXE.")
    if not settings.jy_dir or not (settings.jy_dir / "videoeditor.dll").is_file():
        raise EditError("RUNTIME_UNAVAILABLE", "Configure the matching JY_INSTALL_DIR.")
    return [str(settings.native_exe)], ["--jy-dir", str(settings.jy_dir), "-q"]


def register_templates(capability, editor, jobs):
    templates = Templates(editor)

    @capability()
    def import_local_template(path: str, name: str = "Imported template") -> dict:
        """Copy a local plaintext draft_content JSON into independent template state; source is never edited. Decrypt first if necessary."""
        return templates.import_file(path, name)

    @capability(readonly=True)
    def list_templates(offset: Offset = 0, limit: Limit = 50) -> dict:
        """List service-owned imported template IDs and revisions; independent of normal editable projects."""
        paths = sorted(templates.root.glob("*.json"))
        return {
            "templates": [
                {k: state[k] for k in ["template_id", "name", "revision"]}
                for state in map(read_json, paths[offset : offset + limit])
            ],
            "total": len(paths),
            "next_offset": offset + limit if offset + limit < len(paths) else None,
        }

    @capability(readonly=True)
    def get_template(template_id: str, offset: Offset = 0, limit: Limit = 50) -> dict:
        """Inspect imported template tracks and segment IDs. Timeranges ending _timerange use integer microseconds."""
        return templates.inspect(template_id, offset, limit)

    @capability(readonly=True)
    def inspect_template_resources(template_id: str, offset: Offset = 0, limit: Limit = 50) -> dict:
        """Extract font/fancy-text/bubble/sticker/effect IDs from a local template; does not download or certify resources."""
        return templates.resources(template_id, offset, limit)

    @capability()
    def duplicate_template(template_id: str, name: str) -> dict:
        """Create an independent copy of service-owned template state, preserving the original template."""
        from .core import write_json

        state = templates.load(template_id)
        state.update(template_id=uid(), name=name, revision=0)
        write_json(templates.path(state["template_id"]), state)
        return templates.inspect(state["template_id"])

    @capability()
    def replace_template_material_by_name(
        template_id: str,
        material_name: str,
        path: str,
        kind: Literal["video", "audio"],
        replace_crop: bool = False,
        expected_revision: Revision = None,
    ) -> dict:
        """Replace a uniquely named template media asset in all referencing segments. Preserves segment source ranges/durations; images use kind=video."""
        import pyJianYingDraft as d

        from .core import probe

        media = editor.settings.media_path(path)
        info = probe(editor.settings, media)
        if kind == "audio" and info["kind"] != "audio":
            raise EditError(
                "AUDIO_FILE_REQUIRED", "Use a standalone audio file for template audio replacement."
            )
        material = d.AudioMaterial(str(media)) if kind == "audio" else d.VideoMaterial(str(media))

        def op(script):
            # The SDK intentionally preserves ranges; reject replacements that would exceed a shorter source.
            bucket = "audios" if kind == "audio" else "videos"
            ids = {
                m["id"]
                for m in script.imported_materials.get(bucket, [])
                if m.get("name" if kind == "audio" else "material_name") == material_name
            }
            if info["kind"] != "image":
                for track in script.imported_tracks:
                    for segment in track.raw_data.get("segments", []):
                        src = segment.get("source_timerange")
                        if (
                            segment.get("material_id") in ids
                            and src
                            and src["start"] + src["duration"] > material.duration
                        ):
                            raise EditError(
                                "SOURCE_RANGE_INVALID",
                                "Replacement is shorter than preserved source ranges; use segment replacement.",
                            )
            script.replace_material_by_name(material_name, material, replace_crop=replace_crop)

        return templates.mutate(template_id, expected_revision, op)

    @capability()
    def replace_template_segment(
        template_id: str,
        track_id: str,
        segment_id: str,
        path: str,
        source_in: Seconds = 0,
        source_duration: Positive | None = None,
        shrink: Literal["cut_head", "cut_tail", "cut_tail_align", "shrink"] = "cut_tail",
        extend: Literal["cut_material_tail", "extend_head", "extend_tail", "push_tail"] = "cut_material_tail",
        expected_revision: Revision = None,
    ) -> dict:
        """Replace one template media segment using stable IDs. Supports SDK shrink/extend modes; variable-speed segments are rejected."""
        import pyJianYingDraft as d

        from .core import us

        media = editor.settings.media_path(path)

        def op(script):
            track, index = templates.select(script, track_id, segment_id)
            segment = track.segments[index]
            raw = track.raw_data["segments"][index]
            if raw.get("speed", 1) != 1 or any(
                m.get("id") in raw.get("extra_material_refs", []) and m.get("curve_speed")
                for m in script.imported_materials.get("speeds", [])
            ):
                raise EditError(
                    "VARIABLE_SPEED_REPLACEMENT_UNSUPPORTED",
                    "Template segment replacement requires speed=1 without a speed curve.",
                )
            material = (
                d.AudioMaterial(str(media))
                if track.track_type == d.TrackType.audio
                else d.VideoMaterial(str(media))
            )
            if source_duration is None and source_in == 0:
                source = None
            else:
                length = us(source_duration) if source_duration else material.duration - us(source_in)
                if length <= 0 or (
                    getattr(material, "material_type", None) != "photo"
                    and us(source_in) + length > material.duration
                ):
                    raise EditError("SOURCE_RANGE_INVALID", "Replacement range exceeds source duration.")
                source = d.Timerange(us(source_in), length)
            script.replace_material_by_seg(
                track,
                index,
                material,
                source_timerange=source,
                handle_shrink=d.ShrinkMode[shrink],
                handle_extend=d.ExtendMode[extend],
            )
            # SDK head modes move start but leave the old target duration. speed=1 requires equality.
            segment.duration = segment.source_timerange.duration
            return {"segment_id": segment.raw_data["id"]}

        return templates.mutate(template_id, expected_revision, op)

    @capability()
    def replace_template_text(
        template_id: str,
        track_id: str,
        segment_id: str,
        text: str | list[str],
        recalc_style: bool = True,
        expected_revision: Revision = None,
    ) -> dict:
        """Replace ordinary or multi-part template text while preserving native styling. Use a list for multi-part text templates."""
        values = [text] if isinstance(text, str) else text
        if not values or any(not value.strip() for value in values):
            raise EditError("EMPTY_TEXT", "Replacement text must not be empty.")

        def op(script):
            track, index = templates.select(script, track_id, segment_id)
            script.replace_text(track, index, text, recalc_style=recalc_style)

        return templates.mutate(template_id, expected_revision, op)

    @capability()
    def import_template_track(
        template_id: str,
        source_template_id: str,
        source_track_id: str,
        offset: Seconds = 0,
        new_name: str | None = None,
        at_index: Annotated[int | None, Field(ge=0)] = None,
        expected_revision: Revision = None,
    ) -> dict:
        """Copy a video/audio/text track between template workspaces with media/effect references. SDK IDs are preserved; duplicate IDs are rejected."""
        from .core import us
        from .templates import check_assets

        state = templates.load(source_template_id)
        check_assets(state["source_hashes"])
        source = script_from_content(editor, state["content"])
        track = templates.select(source, source_track_id)
        if track.track_type.name not in {"video", "audio", "text"}:
            raise EditError(
                "UNSUPPORTED_TRACK", "SDK track import supports editable video/audio/text tracks."
            )

        def op(script):
            existing = {t.track_id for t in script.imported_tracks}
            existing.update(s["id"] for t in script.imported_tracks for s in t.raw_data.get("segments", []))
            if track.track_id in existing or any(s.raw_data["id"] in existing for s in track.segments):
                raise EditError(
                    "DUPLICATE_ID", "This track or its segments are already present; SDK preserves IDs."
                )
            all_material_ids = {m.get("id") for bucket in source.imported_materials.values() for m in bucket}
            required = {s.get("material_id") for s in track.raw_data.get("segments", [])}
            required.update(
                ref for s in track.raw_data.get("segments", []) for ref in s.get("extra_material_refs", [])
            )
            missing = required - all_material_ids - {None}
            if missing:
                raise EditError(
                    "MISSING_TEMPLATE_DEPENDENCY",
                    "Source track references missing material IDs.",
                    material_ids=sorted(missing),
                )
            script.import_track(source, track, offset=us(offset), new_name=new_name, at_index=at_index)
            # SDK copies direct refs only. Keep nested template-text/style resource dependencies too.
            from copy import deepcopy

            for bucket, materials in source.imported_materials.items():
                target = script.imported_materials.setdefault(bucket, [])
                by_id = {m.get("id"): m for m in target if m.get("id")}
                for material in materials:
                    mid = material.get("id")
                    if mid in by_id and by_id[mid] != material:
                        raise EditError("MATERIAL_ID_CONFLICT", "Conflicting material IDs across templates.")
                    if mid not in by_id:
                        target.append(deepcopy(material))
                        by_id[mid] = material
            return {"track_id": track.track_id}

        return templates.mutate(template_id, expected_revision, op)

    @capability()
    def save_template_draft(template_id: str, expected_revision: Revision = None) -> dict:
        """Save a new immutable draft snapshot from template state, compatible with export_video. Does not overwrite source or install into Jianying."""
        return templates.save(template_id, expected_revision)

    @capability()
    def convert_local_draft(
        path: str,
        operation: Literal["decrypt", "encrypt", "upgrade", "downgrade"],
        target_version: str | None = None,
    ) -> dict:
        """Convert one local draft content file into a NEW workspace artifact using native jy-draftc; never overwrite input. Downgrade requires target_version."""
        source = input_file(editor, path)
        if operation == "downgrade" and target_version is None:
            raise EditError("TARGET_VERSION_REQUIRED", "Downgrade requires a target version.")
        if target_version and (
            operation not in {"upgrade", "downgrade"}
            or not re.fullmatch(r"\d+(?:\.\d+){1,3}", target_version)
        ):
            raise EditError(
                "INVALID_TARGET_VERSION", "Version must be numeric dotted text for upgrade/downgrade."
            )
        command, flags = native(editor)
        conversion_id = uid()
        directory = editor.root / "conversions" / conversion_id
        directory.mkdir(parents=True)
        output = directory / "result.json"
        source_hash = digest(source)
        command_source = source
        if operation in {"upgrade", "downgrade"}:
            # The installed native converter resolves a draft directory, despite its CLI file syntax.
            staging = directory / "input"
            staging.mkdir()
            shutil.copyfile(source, staging / "draft_content.json")
            from pyJianYingDraft import assets as sdk_assets

            metadata = source.parent / "draft_meta_info.json"
            if not metadata.is_file():
                metadata = Path(sdk_assets.get_asset_path("DRAFT_META_TEMPLATE"))
            shutil.copyfile(metadata, staging / "draft_meta_info.json")
            command_source = staging
            output = directory / "result"
        args = command + [
            {"decrypt": "-dc", "encrypt": "-ec", "upgrade": "-ug", "downgrade": "-dg"}[operation],
            str(command_source),
            "-o",
            str(output),
            *flags,
        ]
        if target_version:
            args += ["-t", target_version]
        if operation in {"upgrade", "downgrade"}:
            args += ["--plain"]
        try:
            result = run(args, timeout=120)
        except EditError as exc:
            write_json(
                directory / "receipt.json",
                {
                    "operation": operation,
                    "source_sha256": source_hash,
                    "error": {"code": exc.code, "message": str(exc), **exc.details},
                },
            )
            raise
        files = [str(output)] if output.is_file() else [str(p) for p in output.rglob("*") if p.is_file()]
        files.sort(key=lambda p: (Path(p).name != "draft_content.json", p))
        if not files:
            raise EditError("CONVERSION_OUTPUT_MISSING", "Native conversion returned no output artifacts.")
        if digest(source) != source_hash:
            raise EditError("SOURCE_CHANGED", "Input changed during conversion.")
        receipt = {
            "conversion_id": conversion_id,
            "operation": operation,
            "artifacts": files,
            "log": (result.stdout + result.stderr)[-4000:],
            "source_preserved": True,
            "native_exported": False,
        }
        write_json(directory / "receipt.json", receipt | {"source_sha256": source_hash})
        return receipt

    @capability(readonly=True)
    def check_local_draft(path: str) -> dict:
        """Run native self-check against a local draft content sample. Read-only input; does not prove visual correctness."""
        source = input_file(editor, path)
        command, flags = native(editor)
        result = run(command + ["-c", str(source), *flags], timeout=120)
        return {"passed": True, "log": (result.stdout + result.stderr)[-6000:], "visual_verified": False}

    @capability()
    def export_local_draft(
        path: str,
        codec: Literal["h264", "hevc"] = "h264",
        bitrate: str = "4M",
        timeout: Annotated[int, Field(ge=10, le=3600)] = 900,
        options: "ExportOptions | None" = None,
    ) -> dict:
        """Snapshot and export a local plaintext draft using the persisted job queue. Encrypted drafts must first be decrypted."""
        if not re.fullmatch(r"[1-9][0-9]{0,8}(?:[KkMm])?", bitrate):
            raise EditError("INVALID_BITRATE", "Use an integer bitrate with optional K/M suffix.")
        imported = templates.import_file(path, "External draft export")
        saved = templates.save(imported["template_id"], imported["revision"])
        return {
            **jobs.export(saved["draft_id"], codec, bitrate, timeout, options),
            "template_id": imported["template_id"],
        }
