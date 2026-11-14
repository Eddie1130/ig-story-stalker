"""Resumable migration from a global cache to account-owned media hard links."""

import json
import os
from pathlib import Path
import re

from worker import atomic


class LayoutError(RuntimeError):
    pass


def local_path(root, relative):
    root = Path(root).resolve()
    relative = Path(relative)
    if relative.is_absolute() or any(p in ("", ".", "..") for p in relative.parts):
        raise LayoutError("TIKTOK_MEDIA_LAYOUT_PATH_INVALID")
    current = root
    for part in relative.parts:
        current = current / part
        if current.is_symlink():
            raise LayoutError("TIKTOK_MEDIA_LAYOUT_SYMLINK")
    return current


def migrate_media_layout(root, db, state_folder):
    marker = Path(state_folder) / "media-layout.json"
    if marker.exists():
        saved = json.loads(marker.read_text())
        if saved.get("version") != 2 or saved.get("layout") != "account-media":
            raise LayoutError("TIKTOK_MEDIA_LAYOUT_INVALID")
        return False
    legacy = local_path(root, "tiktok/media")
    folders = {row[0] for row in db.execute("SELECT folder FROM targets")}
    owners = {}
    for (data,) in db.execute("SELECT data FROM items"):
        record = json.loads(data)
        folder, iid = record["folder"], record["item"]["id"]
        if folder not in folders:
            raise LayoutError("TIKTOK_MEDIA_LAYOUT_OWNER_INVALID")
        owners.setdefault(iid, set()).add(folder)
    moves = []
    if legacy.exists():
        if not legacy.is_dir():
            raise LayoutError("TIKTOK_MEDIA_LAYOUT_INVALID")
        if "media" in folders:
            raise LayoutError("TIKTOK_MEDIA_LAYOUT_RESERVED_ACCOUNT")
        # Validate the whole tree and every collision before removing any cache link.
        for item in sorted(legacy.iterdir()):
            if item.name == ".DS_Store" and item.is_file() and not item.is_symlink():
                target = local_path(root, "tiktok/.legacy-media-metadata/.DS_Store")
                if target.exists() and not os.path.samefile(item, target):
                    raise LayoutError("TIKTOK_MEDIA_LAYOUT_CONFLICT")
                moves.append((item, [target]))
                continue
            if item.is_symlink() or not item.is_dir() or item.name not in owners:
                raise LayoutError("TIKTOK_MEDIA_LAYOUT_UNOWNED")
            for source in sorted(item.iterdir()):
                if (
                    source.is_symlink()
                    or not source.is_file()
                    or not re.fullmatch(r"\d+\.(mp4|jpg|png|webp|part)", source.name)
                ):
                    raise LayoutError("TIKTOK_MEDIA_LAYOUT_UNKNOWN_FILE")
                destinations = [
                    local_path(
                        root,
                        Path("tiktok") / folder / "media" / item.name / source.name,
                    )
                    for folder in sorted(owners[item.name])
                ]
                for target in destinations:
                    if target.exists() and not os.path.samefile(source, target):
                        raise LayoutError("TIKTOK_MEDIA_LAYOUT_CONFLICT")
                moves.append((source, destinations))
        for source, destinations in moves:
            for target in destinations:
                target.parent.mkdir(parents=True, exist_ok=True)
                try:
                    os.link(source, target)
                except FileExistsError:
                    if not os.path.samefile(source, target):
                        raise LayoutError("TIKTOK_MEDIA_LAYOUT_CONFLICT") from None
            if not all(os.path.samefile(source, target) for target in destinations):
                raise LayoutError("TIKTOK_MEDIA_LAYOUT_INCOMPLETE")
            # Only remove the obsolete cache link, after all account links are verified.
            source.unlink()
        for item in sorted(legacy.iterdir()):
            item.rmdir()
        legacy.rmdir()
    atomic(
        marker, {"version": 2, "layout": "account-media", "migratedFiles": len(moves)}
    )
    return bool(moves)


def account_media(root, db, folder, iid, index):
    """Find an account-local cache entry or hard-link another account's copy."""
    stem = f"{index:02d}"
    destination = local_path(root, Path("tiktok") / folder / "media" / iid / stem)
    for (other,) in db.execute("SELECT folder FROM targets"):
        if other == folder:
            continue
        base = local_path(root, Path("tiktok") / other / "media" / iid / stem)
        candidates = [
            p
            for p in base.parent.glob(stem + ".*")
            if p.suffix in (".mp4", ".jpg", ".png", ".webp")
        ]
        if len(candidates) == 1:
            source = local_path(root, candidates[0].relative_to(Path(root).resolve()))
            if not source.is_file():
                continue
            target = destination.with_suffix(source.suffix)
            target.parent.mkdir(parents=True, exist_ok=True)
            try:
                os.link(source, target)
            except FileExistsError:
                if not os.path.samefile(source, target):
                    raise LayoutError("TIKTOK_MEDIA_LAYOUT_CONFLICT") from None
            return target
    return None
