"""Export only completed media and explicitly selected public metadata."""
import json
import os
from pathlib import Path, PurePosixPath
import re
import sqlite3
import stat
import time
from urllib.parse import urlsplit

MAPS = {"ig": "targets", "x": "xTargets", "tt": "tiktokTargets"}
MEDIA = {".jpg", ".jpeg", ".png", ".webp", ".mp4", ".gif", ".m4a"}


def valid_name(platform, name):
    patterns = {"ig": r"[a-z0-9_.]{1,30}", "x": r"[a-z0-9_]{1,15}", "tt": r"[a-z0-9_][a-z0-9_.]{0,23}"}
    return isinstance(name, str) and name not in {".", "..", "manual"} and bool(re.fullmatch(patterns.get(platform, r"(?!)"), name))


def generation(settings, uid, platform, name):
    if not valid_name(platform, name) or uid not in settings["allowedIds"]:
        return None
    if uid == settings["ownerId"]:
        return "owner"
    return settings["users"].get(uid, {}).get(MAPS[platform], {}).get(name, {}).get("generation")


def safe_open(root, relative):
    """Walk directory descriptors: symlinks, including replaced parents, cannot escape."""
    parts = PurePosixPath(relative).parts
    if not parts or relative.startswith("/") or "\\" in relative or any(p in {".", ".."} for p in parts) or "\0" in relative:
        raise ValueError("UNSAFE_PATH")
    fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in parts[:-1]:
            new = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = new
        result = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
    finally:
        os.close(fd)
    if not stat.S_ISREG(os.fstat(result).st_mode):
        os.close(result)
        raise ValueError("UNSAFE_PATH")
    return os.fdopen(result, "rb")


def read_json(root, relative, fallback=None):
    try:
        with safe_open(root, relative) as stream:
            return json.load(stream)
    except FileNotFoundError:
        if (Path(root) / (relative + ".required")).exists():
            raise ValueError("ARCHIVE_HISTORY_MISSING") from None
        if fallback is not None:
            return fallback
        raise


def public_url(value, platform):
    try:
        parsed = urlsplit(value)
        hosts = {"ig": {"instagram.com", "www.instagram.com"}, "x": {"x.com", "www.x.com", "twitter.com"}, "tt": {"www.tiktok.com", "tiktok.com"}}
        if parsed.scheme == "https" and parsed.hostname in hosts[platform] and not parsed.username and not parsed.password and not parsed.port:
            return f"https://{parsed.hostname}{parsed.path}"
    except (TypeError, ValueError):
        pass
    return None


def folder_name(value):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_.]{1,80}", value) or value in {".", "..", "manual"}:
        raise ValueError("UNSAFE_ACCOUNT_FOLDER")
    return value


class Snapshot:
    def __init__(self, root, state, platform, name):
        if not valid_name(platform, name):
            raise ValueError("INVALID_ACCOUNT")
        self.root, self.state = Path(root).resolve(strict=True), Path(state).resolve(strict=True)
        self.platform, self.name = platform, name
        self.cutoff = time.time_ns()
        self.files, self.missing, self.records = {}, [], []
        self.account_roots = []

    def add(self, relative, expected=False):
        relative = str(relative)
        if not any(relative.startswith(prefix + "/") for prefix in self.account_roots):
            raise ValueError("UNSAFE_ACCOUNT_PATH")
        if Path(relative).suffix.lower() not in MEDIA and Path(relative).name != "caption.txt" and not (self.platform == "x" and re.search(r"/posts/\d+\.txt$", relative)):
            return
        if any(part.startswith(".") or ".part" in part or part in {"manual", "media"} and self.platform == "tt" for part in PurePosixPath(relative).parts):
            return
        try:
            with safe_open(self.root, relative) as stream:
                info = os.fstat(stream.fileno())
            if not info.st_size:
                raise ValueError("EMPTY_FILE")
            if max(info.st_mtime_ns, info.st_ctime_ns) > self.cutoff:
                return  # Completed/updated after this snapshot began.
            self.files[relative] = {"path": relative, "size": info.st_size, "dev": info.st_dev, "ino": info.st_ino, "mtime": info.st_mtime_ns}
        except (OSError, ValueError):
            if expected or relative not in self.missing:
                self.missing.append(relative)

    def walk(self, relative):
        folder = self.root / relative
        try:
            if folder.is_symlink():
                raise ValueError("UNSAFE_DIRECTORY")
            # Resolve every parent before listing; final file opens are descriptor based.
            if folder.resolve() != folder.absolute():
                raise ValueError("UNSAFE_DIRECTORY")
            for entry in sorted(folder.iterdir()):
                if entry.name.startswith(".") or ".part" in entry.name or entry.name.endswith("_parts") or entry.name.endswith("_flv.mp4"):
                    continue
                if entry.is_symlink():
                    self.missing.append(str(entry.relative_to(self.root)))
                elif entry.is_dir():
                    self.walk(str(entry.relative_to(self.root)))
                elif entry.is_file():
                    self.add(str(entry.relative_to(self.root)))
        except FileNotFoundError:
            return

    def instagram(self):
        layout = read_json(self.state, "archive-layout.json", {})
        health = read_json(self.state, "health.json", {})
        ids = [str(t["target"]) for t in health.get("targets", []) if t.get("username") == self.name and str(t.get("target", "")).isdigit()]
        if not ids:
            ids = [uid for uid, folder in layout.get("accounts", {}).items() if folder == self.name]
        if len(set(ids)) != 1:
            raise ValueError("ACCOUNT_NOT_RESOLVED")
        uid = ids[0]
        base = "instagram/" + folder_name(layout.get("accounts", {}).get(uid, self.name))
        self.account_roots = [base]
        for category in ("stories", "posts", "highlight"):
            self.walk(base + "/" + category)
        archive = read_json(self.state, f"archive-{uid}.json", {})
        for iid, record in archive.get("saved", {}).items():
            relative = record.get("relativePath")
            if relative:
                self.add(base + "/" + relative, True)
                # Original Story timestamps survive in the archive filename.
                stamp = re.search(r"(\d{8}_\d{6})_JST", relative)
                self.records.append({"kind": "story", "id": iid, "url": f"https://www.instagram.com/stories/{self.name}/{iid.split('_')[0]}/", "publishedAtJST": stamp[1] if stamp else None, "files": [base + "/" + relative]})
        catalog = read_json(self.state, f"catalog-{uid}.json", {})
        for asset in catalog.get("assets", {}).values():
            if asset.get("archiveDone") and asset.get("relativePath"):
                relative = base + "/" + asset["relativePath"]
                self.add(relative, True)
                code = asset.get("code")
                url = f"https://www.instagram.com/p/{code}/" if code and re.fullmatch(r"[A-Za-z0-9_-]+", code) else None
                if asset.get("kind") == "highlight":
                    url = f"https://www.instagram.com/stories/highlights/{asset['parent']}/"
                self.records.append({"kind": asset.get("kind"), "id": asset.get("id"), "publishedAt": asset.get("takenAt"), "url": url, "caption": catalog.get("captions", {}).get(asset.get("parent"), {}).get("text", ""), "files": [relative]})

    def twitter(self):
        base = "x/" + self.name
        self.account_roots = [base]
        self.walk(base + "/media")
        self.walk(base + "/posts")
        posts = self.root / base / "posts"
        if not posts.exists():
            return
        for file in sorted(posts.glob("*.json")):
            if not re.fullmatch(r"\d+\.json", file.name):
                continue
            try:
                with safe_open(self.root, str(file.relative_to(self.root))) as stream:
                    info = os.fstat(stream.fileno())
                    if max(info.st_mtime_ns, info.st_ctime_ns) > self.cutoff:
                        continue
                    data = json.load(stream)
                result, event = data.get("result", {}), data.get("event", {})
                files = [f["relativePath"] for f in result.get("files", [])]
                for relative in files:
                    self.add(relative, True)
                for index, _ in enumerate(result.get("errors", []), 1):
                    self.missing.append(f"{base}/posts/{file.stem}:media-error-{index}")
                self.records.append({"id": result.get("contentId"), "kind": result.get("kind"), "caption": result.get("caption", ""), "url": public_url(result.get("url"), "x"), "publishedAt": event.get("publishedAt"), "files": files})
            except (OSError, ValueError, KeyError):
                self.missing.append(str(file.relative_to(self.root)))

    def tiktok(self):
        folders = {self.name}
        db_file = self.state / "tiktok/catalog/catalog.sqlite"
        if not db_file.exists() and db_file.with_suffix(".required").exists():
            raise ValueError("ARCHIVE_HISTORY_MISSING")
        if db_file.exists():
            with sqlite3.connect(db_file.as_uri() + "?mode=ro", uri=True) as db:
                rows = db.execute("SELECT data FROM items").fetchall()
                for (raw,) in rows:
                    record = json.loads(raw)
                    if record.get("username") != self.name:
                        continue
                    folders.add(folder_name(record["folder"]))
                    if record.get("status") != "ready":
                        continue
                    item = record["item"]
                    self.records.append({"kind": record["kind"], "id": item.get("id"), "caption": item.get("caption", ""), "publishedAt": item.get("publishedAt"), "url": public_url(item.get("url"), "tt") or f"https://www.tiktok.com/@{item.get('author', self.name)}/video/{item.get('id', '')}", "files": record.get("files", [])})
        self.account_roots = ["tiktok/" + folder_name(folder) for folder in sorted(folders)]
        for base in self.account_roots:
            for category in ("posts", "reposts", "stories", "profile", "likes", "live"):
                self.walk(base + "/" + category)
        for record in self.records:
            originals = []
            for relative in record["files"]:
                parts = PurePosixPath(relative).parts
                if len(parts) >= 2 and parts[-2].endswith("_parts"):
                    original = str(PurePosixPath(*parts[:-2]) / (parts[-2][:-6] + ".mp4"))
                    self.add(original, True)
                    if original in self.files:
                        originals.append(original)
                        continue
                self.add(relative, True)
                originals.append(relative)
            record["files"] = list(dict.fromkeys(originals))
        # A final MP4 can exist while finalization/splitting is still in progress.
        for subdir in ("captures", "processing"):
            folder = self.state / "tiktok" / subdir
            for file in folder.glob("*.json"):
                job = read_json(self.state, str(file.relative_to(self.state)))
                if job.get("username") == self.name:
                    for key in ("source", "dest"):
                        value = job.get(key, "")
                        for prefix in (str(self.root) + "/", "/downloads/"):
                            if value.startswith(prefix):
                                self.files.pop(value[len(prefix):], None)
        for relative in self.files:
            if "/live/" in relative:
                stamp = re.search(r"(\d{8}_\d{6})_JST", relative)
                self.records.append({"kind": "live", "url": f"https://www.tiktok.com/@{self.name}/live", "recordedAtJST": stamp[1] if stamp else None, "files": [relative]})

    def collect(self):
        {"ig": self.instagram, "x": self.twitter, "tt": self.tiktok}[self.platform]()
        selected = set(self.files) | set(self.missing)
        records = []
        for record in self.records:
            files = record.get("files", [])
            if files:
                chosen = [file for file in files if file in selected]
                if not chosen:
                    continue
                record = {**record, "files": chosen}
            records.append(record)
        self.records = records
        return {"files": list(self.files.values()), "missing": sorted(set(self.missing)), "records": self.records, "bytes": sum(f["size"] for f in self.files.values())}
