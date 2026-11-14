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


def _migrate_account_layout(root, db, state_folder):
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


def migrate_media_layout(root, db, state_folder):
    """Upgrade global/v2 caches to flat account media; preserve all archive aliases."""
    marker = Path(state_folder) / "media-layout.json"
    if marker.exists():
        saved = json.loads(marker.read_text())
        if saved.get("version") == 3 and saved.get("layout") == "account-media-flat":
            return False
    _migrate_account_layout(root, db, state_folder)
    owners = {}
    for (data,) in db.execute("SELECT data FROM items"):
        record = json.loads(data)
        owners.setdefault(record["folder"], set()).add(record["item"]["id"])
    moves, directories = [], []
    for (folder,) in db.execute("SELECT folder FROM targets"):
        media = local_path(root, Path("tiktok") / folder / "media")
        if not media.exists():
            continue
        if not media.is_dir():
            raise LayoutError("TIKTOK_MEDIA_LAYOUT_INVALID")
        for entry in sorted(media.iterdir()):
            local_path(root, entry.relative_to(Path(root).resolve()))
            if entry.name == ".DS_Store" and entry.is_file():
                target = local_path(
                    root, Path("tiktok/.legacy-media-metadata") / folder / ".DS_Store"
                )
                moves.append((entry, target))
            elif (
                entry.is_file()
                and re.fullmatch(r".+_\d+\.(mp4|jpg|png|webp|part)", entry.name)
                and entry.stem.rsplit("_", 1)[0] in owners.get(folder, set())
            ):
                continue
            elif entry.is_dir() and entry.name in owners.get(folder, set()):
                directories.append(entry)
                for source in sorted(entry.iterdir()):
                    local_path(root, source.relative_to(Path(root).resolve()))
                    if source.name == ".DS_Store" and source.is_file():
                        target = local_path(
                            root,
                            Path("tiktok/.legacy-media-metadata")
                            / folder
                            / entry.name
                            / ".DS_Store",
                        )
                    elif source.is_file() and re.fullmatch(
                        r"\d+\.(mp4|jpg|png|webp|part)", source.name
                    ):
                        target = local_path(
                            root,
                            Path("tiktok")
                            / folder
                            / "media"
                            / f"{entry.name}_{source.name}",
                        )
                    else:
                        raise LayoutError("TIKTOK_MEDIA_LAYOUT_UNKNOWN_FILE")
                    moves.append((source, target))
            else:
                raise LayoutError("TIKTOK_MEDIA_LAYOUT_UNOWNED")
    # Preflight every account before changing any link.
    for source, target in moves:
        if target.exists() and not os.path.samefile(source, target):
            raise LayoutError("TIKTOK_MEDIA_LAYOUT_CONFLICT")
    for source, target in moves:
        target.parent.mkdir(parents=True, exist_ok=True)
        try:
            os.link(source, target)
        except FileExistsError:
            if not os.path.samefile(source, target):
                raise LayoutError("TIKTOK_MEDIA_LAYOUT_CONFLICT") from None
        if not os.path.samefile(source, target):
            raise LayoutError("TIKTOK_MEDIA_LAYOUT_INCOMPLETE")
        source.unlink()
    for directory in directories:
        directory.rmdir()
    atomic(
        marker,
        {"version": 3, "layout": "account-media-flat", "migratedFiles": len(moves)},
    )
    return bool(moves)


def account_media(root, db, folder, iid, index):
    """Find an account-local cache entry or hard-link another account's copy."""
    stem = f"{index:02d}"
    destination = local_path(root, Path("tiktok") / folder / "media" / f"{iid}_{stem}")
    for (other,) in db.execute("SELECT folder FROM targets"):
        if other == folder:
            continue
        base = local_path(root, Path("tiktok") / other / "media" / f"{iid}_{stem}")
        candidates = [
            p
            for p in base.parent.glob(base.name + ".*")
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
