"""Single-writer export queue with independent, bounded HTTP download threads."""
from contextlib import contextmanager
import fcntl
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import signal
import sqlite3
import threading
import time
from urllib.parse import urlsplit
import zipfile

from .snapshot import MAPS, Snapshot, generation, read_json, safe_open, valid_name

TTL = 24 * 3600
RESERVE = 1024**3
ACTIVE = {"queued", "building"}


def atomic(file, value):
    temporary = file.with_name(file.name + ".tmp")
    with open(temporary, "w", encoding="utf-8", opener=lambda p, flags: os.open(p, flags, 0o600)) as stream:
        json.dump(value, stream, ensure_ascii=False)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, file)
    fd = os.open(file.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def byte_range(value, size):
    if value is None:
        return 0, size - 1, False
    match = re.fullmatch(r"bytes=(\d*)-(\d*)", value)
    if not match or not any(match.groups()):
        raise ValueError("INVALID_RANGE")
    left, right = match.groups()
    if left:
        start, end = int(left), min(int(right), size - 1) if right else size - 1
    else:
        count = int(right)
        if count <= 0:
            raise ValueError("INVALID_RANGE")
        start, end = max(0, size - count), size - 1
    if start > end or start >= size:
        raise ValueError("INVALID_RANGE")
    return start, end, True


class ExportService:
    def __init__(self, root, watch, control, directory, base_url, clock=time.time):
        parsed = urlsplit(base_url)
        if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.port not in (None, 443) or parsed.path not in ("", "/") or parsed.query or parsed.fragment:
            raise ValueError("EXPORT_HTTPS_ORIGIN_REQUIRED")
        self.root, self.watch, self.control = Path(root).absolute(), Path(watch).absolute(), Path(control).absolute()
        self.dir, self.base_url, self.clock = Path(directory).absolute(), base_url.rstrip("/"), clock
        if not self.root.is_dir() or self.root.is_symlink():
            raise ValueError("EXPORT_DOWNLOAD_MOUNT_MISSING")
        self.dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        if self.dir.is_symlink() or self.dir == self.root or self.root in self.dir.parents:
            raise ValueError("EXPORT_UNSAFE_OUTPUT_DIRECTORY")
        os.chmod(self.dir, 0o700)
        self.guard = threading.RLock()
        self.downloads = {}
        self.stop = threading.Event()
        self.worker = None
        file = self.dir / "state.json"
        if (self.dir / "state.required").exists() and not file.exists():
            raise ValueError("EXPORT_HISTORY_MISSING")
        self.state = read_json(self.dir, "state.json", {"version": 1, "jobs": {}, "previews": {}, "processed": {}, "reports": {}})
        if self.state.get("version") != 1 or any(not isinstance(self.state.get(key), dict) for key in ("jobs", "previews", "processed", "reports")):
            raise ValueError("EXPORT_INVALID_STATE")
        for job in self.state["jobs"].values():
            if job["status"] == "building":
                job["status"] = "queued"
            if not re.fullmatch(r"[a-f0-9]{24}", job["id"]):
                raise ValueError("EXPORT_INVALID_JOB")
        for temporary in self.dir.glob("*.part"):
            if re.fullmatch(r"[a-f0-9]{24}\.part", temporary.name):
                temporary.unlink()
        self.persist()
        (self.dir / "state.required").touch(mode=0o600, exist_ok=True)

    def settings(self):
        value = read_json(self.control, "settings.json")
        if value.get("version") != 1 or value.get("ownerId") not in value.get("allowedIds", []) or not isinstance(value.get("users"), dict):
            raise ValueError("EXPORT_SETTINGS_INVALID")
        return value

    def persist(self):
        with self.guard:
            atomic(self.dir / "state.json", self.state)
            # Controller receives messages, never internal paths or the token hash table.
            atomic(self.dir / "reports.json", self.state["reports"])

    def report(self, uid, text, rows=None, request=None, grant=None):
        identity = secrets.token_hex(12)
        self.state["reports"][identity] = {"userId": uid, "text": text, "rows": rows or [], "requestId": request, "grant": grant}

    @staticmethod
    def buttons(platform, name):
        return [[{"text": "🔄 匯出狀態", "callback_data": f"ex:status:{platform}:{name}"}, {"text": "取消匯出", "callback_data": f"ex:cancel:{platform}:{name}"}]]

    def has_waiters(self, job, settings):
        return any(generation(settings, uid, job["platform"], job["name"]) == waiter["generation"] for uid, waiter in job["waiters"].items())

    def ready(self, job, uid, request=None):
        token = secrets.token_urlsafe(32)
        waiter = job["waiters"][uid]
        waiter.setdefault("hashes", []).append(hashlib.sha256(token.encode()).hexdigest())
        missing = job.get("missing", 0)
        text = f"{'⚠️ 封存不完整' if missing else '✅ 封存匯出完成'}：{job['platform'].upper()} @{job['name']}\n快照：{time.strftime('%Y-%m-%d %H:%M:%S UTC', time.gmtime(job['snapshotAt']))}\nZIP：{job['bytes'] / 1024**3:.2f} GiB；缺失 {missing} 項\n到期：{time.strftime('%Y-%m-%d %H:%M:%S UTC', time.gmtime(job['expires']))}\n持有連結即可下載，請審慎轉傳。\n{self.base_url}/files/{token}"
        grant = {"platform": job["platform"], "name": job["name"], "generation": waiter["generation"], "expires": job["expires"]}
        self.report(uid, text, self.buttons(job["platform"], job["name"]), request, grant)

    def preview(self, command, settings):
        uid, platform, name = command["userId"], command["platform"], command["name"]
        gen = generation(settings, uid, platform, name)
        snapshot = Snapshot(self.root, self.watch, platform, name).collect()
        identity = secrets.token_hex(8)
        self.state["previews"][identity] = {"userId": uid, "platform": platform, "name": name, "generation": gen, "expires": self.clock() + 600}
        text = f"匯出 {platform.upper()} @{name} 的全部自動封存\n目前可讀檔案：{len(snapshot['files'])}；估算 {snapshot['bytes'] / 1024**3:.2f} GiB\n已知缺失：{len(snapshot['missing'])} 項\n包含已有說明、來源清單；TikTok 包含已完成 LIVE。\n實際快照於開始打包時建立；有效 ZIP 會重用且不延長期限。\n確認後排隊，完成後下載連結有效 24 小時。"
        rows = [[{"text": "確認匯出", "callback_data": "ex:confirm:" + identity}, {"text": "取消", "callback_data": "menu"}]]
        self.report(uid, text, rows, command["id"])

    def confirm(self, command, settings):
        preview = self.state["previews"].get(command.get("preview"))
        uid = command["userId"]
        if not preview or preview["userId"] != uid or preview["expires"] <= self.clock() or generation(settings, uid, preview["platform"], preview["name"]) != preview["generation"]:
            raise ValueError("PREVIEW_EXPIRED")
        platform, name = preview["platform"], preview["name"]
        jobs = self.state["jobs"]
        # Repeated confirmation of the same target is harmless.
        existing = next((job for job in jobs.values() if job["platform"] == platform and job["name"] == name and (job["status"] in ACTIVE or job["status"] == "ready" and job["expires"] > self.clock())), None)
        if any(uid in job["waiters"] and job["status"] in ACTIVE and job is not existing for job in jobs.values()):
            raise ValueError("ONE_PENDING_REQUEST")
        if not existing:
            identity = secrets.token_hex(12)
            existing = {"id": identity, "platform": platform, "name": name, "status": "queued", "waiters": {}, "at": self.clock(), "done": 0}
            jobs[identity] = existing
        existing["waiters"].setdefault(uid, {"generation": preview["generation"]})
        if existing["status"] == "ready":
            self.ready(existing, uid, command["id"])
        else:
            self.report(uid, f"已排隊匯出 {platform.upper()} @{name}；同一帳號共用打包工作。", self.buttons(platform, name), command["id"])

    def command(self, command, settings):
        uid, action = command["userId"], command["action"]
        if uid not in settings["allowedIds"]:
            return
        if action == "confirm":
            self.confirm(command, settings)
            return
        if action == "owner":
            if uid != settings["ownerId"]:
                raise ValueError("FORBIDDEN")
            names = self.accounts(command["platform"], settings)
            page = min(max(command.get("page", 0), 0), max(0, (len(names) - 1) // 8))
            rows = [[{"text": "@" + name, "callback_data": f"ex:preview:{command['platform']}:{name}"}] for name in names[page * 8:page * 8 + 8]]
            if page:
                rows.append([{"text": "上一頁", "callback_data": f"ex:owner:{command['platform']}:{page - 1}"}])
            if (page + 1) * 8 < len(names):
                rows.append([{"text": "下一頁", "callback_data": f"ex:owner:{command['platform']}:{page + 1}"}])
            self.report(uid, "管理員：選擇要匯出的帳號" if names else "尚無已知封存帳號。", rows, command["id"])
            return
        platform, name = command["platform"], command["name"]
        if not generation(settings, uid, platform, name):
            raise ValueError("FORBIDDEN")
        if action == "preview":
            self.preview(command, settings)
            return
        found = [job for job in self.state["jobs"].values() if job["platform"] == platform and job["name"] == name and uid in job["waiters"]]
        job = max(found, key=lambda j: j["at"]) if found else None
        if action == "cancel":
            for item in found:
                item["waiters"].pop(uid, None)
            # Preserve request acknowledgements even when its download is revoked.
            for report in self.state["reports"].values():
                grant = report.get("grant") or {}
                if report["userId"] == uid and grant.get("name") == name and grant.get("platform") == platform:
                    report.update(text="此下載連結已撤銷。", grant=None, rows=[])
            self.report(uid, "已取消你的申請並撤銷下載連結；其他申請者不受影響。", request=command["id"])
        elif action == "status":
            if job and job["status"] == "ready" and job["expires"] > self.clock():
                self.ready(job, uid, command["id"])
            else:
                labels = {"queued": "排隊中", "building": "打包中", "failed": "失敗", "cancelled": "已取消", "expired": "已到期"}
                text = labels.get(job["status"], "尚無申請") if job else "尚無申請"
                if job and job["status"] == "building":
                    text += f"；已處理 {job.get('done', 0)}/{job.get('total', 0)} 個檔案"
                self.report(uid, f"{platform.upper()} @{name}：{text}", self.buttons(platform, name), command["id"])

    def accounts(self, platform, settings):
        names = set()
        for user in settings["users"].values():
            names.update(user.get(MAPS[platform], {}))
        base = self.root / {"ig": "instagram", "x": "x", "tt": "tiktok"}[platform]
        if base.is_dir() and not base.is_symlink():
            names.update(entry.name for entry in base.iterdir() if entry.is_dir() and not entry.is_symlink() and entry.name != "manual")
        if platform == "ig":
            names.update(t["username"] for t in read_json(self.watch, "health.json", {}).get("targets", []) if t.get("username"))
        return sorted(name for name in names if valid_name(platform, name))

    def tick(self):
        settings = self.settings()  # Fail closed if settings cannot be read.
        with self.guard:
            for key in settings.get("exportReceipts", {}):
                self.state["reports"].pop(key, None)
            for job in self.state["jobs"].values():
                job["waiters"] = {uid: waiter for uid, waiter in job["waiters"].items() if generation(settings, uid, job["platform"], job["name"]) == waiter["generation"]}
                if job["status"] == "queued" and not job["waiters"]:
                    job["status"] = "cancelled"
                if job["status"] == "ready" and job["expires"] <= self.clock():
                    job["status"] = "expired"
                if job["status"] in {"expired", "cancelled", "failed"} and not self.downloads.get(job["id"]):
                    (self.dir / (job["id"] + ".zip")).unlink(missing_ok=True)
            for command in settings.get("exportRequests", {}).values():
                identity = command.get("id", "")
                if identity in self.state["processed"]:
                    continue
                if not re.fullmatch(r"\d{1,20}-\d{1,16}", identity) or not identity.startswith(str(command.get("userId")) + "-"):
                    raise ValueError("EXPORT_INVALID_COMMAND")
                try:
                    self.command(command, settings)
                except (OSError, ValueError, KeyError, sqlite3.Error) as error:
                    reasons = {"FORBIDDEN": "目前沒有此帳號的匯出權限。", "PREVIEW_EXPIRED": "確認畫面已過期或權限已變更，請重新開啟匯出。", "ONE_PENDING_REQUEST": "每人最多一個未完成申請，請先等待或取消原本的匯出。", "ACCOUNT_NOT_RESOLVED": "帳號尚未解析，請等待監控完成首次初始化。"}
                    self.report(command["userId"], reasons.get(str(error), "無法讀取完整封存資料，請稍後再試或聯絡管理員。"), request=identity)
                self.state["processed"][identity] = True
            self.state["processed"] = {key: True for key in self.state["processed"] if key in settings.get("exportRequests", {})}
            self.state["previews"] = {key: value for key, value in self.state["previews"].items() if value["expires"] > self.clock()}
            self.persist()
            if not self.stop.is_set() and (not self.worker or not self.worker.is_alive()):
                job = next((job for job in self.state["jobs"].values() if job["status"] == "queued"), None)
                if job:
                    job["status"] = "building"
                    self.persist()
                    self.worker = threading.Thread(target=self.build, args=(job,), name="archive-builder", daemon=True)
                    self.worker.start()
        atomic(self.dir / "health.json", {"at": int(self.clock() * 1000)})

    def build(self, job):
        temporary = self.dir / (job["id"] + ".part")
        try:
            snapshot_at = self.clock()
            snapshot = Snapshot(self.root, self.watch, job["platform"], job["name"]).collect()
            if not snapshot["files"] and not snapshot["records"]:
                raise ValueError("NO_ARCHIVED_FILES")
            # ZIP_STORED avoids recompressing media; reserve directory/manifest overhead.
            needed = snapshot["bytes"] + len(snapshot["files"]) * 1024 + len(json.dumps(snapshot).encode()) + RESERVE
            if shutil.disk_usage(self.dir).free < needed:
                raise ValueError("INSUFFICIENT_SPACE")
            with self.guard:
                job.update(snapshotAt=snapshot_at, total=len(snapshot["files"]), done=0)
                self.persist()
            missing = list(snapshot["missing"])
            saved = []
            with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_STORED, allowZip64=True) as archive:
                os.chmod(temporary, 0o600)
                for item in snapshot["files"]:
                    self.check_build(job)
                    relative = item["path"]
                    try:
                        source = safe_open(self.root, relative)
                    except (OSError, ValueError):
                        missing.append(relative)
                        continue
                    with source:
                        info = os.fstat(source.fileno())
                        if (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns) != (item["dev"], item["ino"], item["size"], item["mtime"]):
                            missing.append(relative)
                            continue
                        with archive.open(relative, "w", force_zip64=True) as output:
                            remaining = item["size"]
                            last_check = 0
                            while remaining:
                                if time.monotonic() - last_check > 1:
                                    self.check_build(job)
                                    if shutil.disk_usage(self.dir).free < RESERVE:
                                        raise ValueError("INSUFFICIENT_SPACE")
                                    last_check = time.monotonic()
                                chunk = source.read(min(1024**2, remaining))
                                if not chunk:
                                    raise ValueError("SOURCE_CHANGED_DURING_EXPORT")
                                output.write(chunk)
                                remaining -= len(chunk)
                        if os.fstat(source.fileno()).st_mtime_ns != item["mtime"]:
                            missing.append(relative)
                        else:
                            saved.append(relative)
                    with self.guard:
                        job["done"] += 1
                manifest = {"platform": job["platform"], "account": job["name"], "snapshotAt": snapshot_at, "files": saved, "missing": sorted(set(missing)), "records": snapshot["records"]}
                archive.writestr("export-manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2))
                archive.writestr("缺失清單.txt", "\n".join(manifest["missing"]) or "沒有已知缺失。")
            with open(temporary, "rb") as stream:
                os.fsync(stream.fileno())
            self.check_build(job)
            with self.guard:
                os.replace(temporary, self.dir / (job["id"] + ".zip"))
                job.update(status="ready", expires=self.clock() + TTL, bytes=(self.dir / (job["id"] + ".zip")).stat().st_size, missing=len(set(missing)))
                settings = self.settings()
                for uid, waiter in list(job["waiters"].items()):
                    if generation(settings, uid, job["platform"], job["name"]) == waiter["generation"]:
                        self.ready(job, uid)
                self.persist()
        except Exception as error:
            with self.guard:
                if self.stop.is_set():
                    job["status"] = "queued"
                else:
                    job["status"] = "cancelled" if str(error) == "EXPORT_CANCELLED" else "failed"
                    text = {"INSUFFICIENT_SPACE": "磁碟空間不足，已停止匯出；原始封存與其他有效 ZIP 均保留。", "NO_ARCHIVED_FILES": "尚無可匯出的已完成封存。"}.get(str(error), "匯出未完成，請重新申請或聯絡管理員；原始封存仍保留。")
                    for uid in job["waiters"]:
                        self.report(uid, text)
                self.persist()
        finally:
            temporary.unlink(missing_ok=True)

    def check_build(self, job):
        with self.guard:
            if self.stop.is_set() or not self.has_waiters(job, self.settings()):
                raise ValueError("EXPORT_CANCELLED")

    @contextmanager
    def download(self, token):
        digest = hashlib.sha256(token.encode()).hexdigest()
        job = None
        stream = None
        with self.guard:
            settings = self.settings()
            for candidate in self.state["jobs"].values():
                if candidate["status"] != "ready" or candidate["expires"] <= self.clock():
                    continue
                for uid, waiter in candidate["waiters"].items():
                    if any(secrets.compare_digest(value, digest) for value in waiter.get("hashes", [])) and generation(settings, uid, candidate["platform"], candidate["name"]) == waiter["generation"]:
                        job = candidate
                        break
                if job:
                    break
            if job:
                stream = safe_open(self.dir, job["id"] + ".zip")
                self.downloads[job["id"]] = self.downloads.get(job["id"], 0) + 1
        try:
            yield job, stream
        finally:
            if stream:
                stream.close()
                with self.guard:
                    self.downloads[job["id"]] -= 1


class DownloadServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address, service):
        self.service = service
        self.slots = threading.BoundedSemaphore(8)
        super().__init__(address, Handler)

    def process_request(self, request, client_address):
        if not self.slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except BaseException:
            self.slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.slots.release()

    def handle_error(self, *_):
        pass  # Never log a request URL/token.


class Handler(BaseHTTPRequestHandler):
    server_version = "ArchiveDownload"
    sys_version = ""

    def log_message(self, *_):
        pass

    def do_GET(self):
        self.transfer(False)

    def do_HEAD(self):
        self.transfer(True)

    def transfer(self, head):
        self.connection.settimeout(60)
        match = re.fullmatch(r"/files/([A-Za-z0-9_-]{43})", self.path)
        if not match:
            self.send_error(404)
            return
        try:
            with self.server.service.download(match[1]) as (job, stream):
                if not job:
                    self.send_error(404)
                    return
                size = os.fstat(stream.fileno()).st_size
                # A stable validator allows download managers to resume one snapshot.
                etag = '"' + job["id"] + '"'
                requested_range = self.headers.get("Range") if self.headers.get("If-Range", etag) == etag else None
                try:
                    start, end, partial = byte_range(requested_range, size)
                except ValueError:
                    self.send_response(416)
                    self.send_header("Content-Range", f"bytes */{size}")
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                self.send_response(206 if partial else 200)
                for key, value in {"Content-Type": "application/zip", "Content-Disposition": f'attachment; filename="{job["platform"]}_{job["name"]}_archive.zip"', "Content-Length": str(end - start + 1), "Accept-Ranges": "bytes", "ETag": etag, "Cache-Control": "private, no-store, no-transform", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'"}.items():
                    self.send_header(key, value)
                if partial:
                    self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
                self.end_headers()
                if head:
                    return
                stream.seek(start)
                remaining = end - start + 1
                while remaining:
                    chunk = stream.read(min(256 * 1024, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
        except (BrokenPipeError, ConnectionError, TimeoutError):
            pass
        except (OSError, ValueError, KeyError):
            self.close_connection = True
            # Settings or storage failures never grant access.


def main():
    directory = Path(os.getenv("EXPORT_DIR", "/exports"))
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    with open(directory / ".lock", "a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        service = ExportService(os.getenv("IG_ARCHIVE_DIR", "/downloads"), os.getenv("IG_STATE_DIR", "/watch"), os.getenv("IG_CONTROL_DIR", "/control"), directory, os.environ["ARCHIVE_EXPORT_BASE_URL"])
        server = DownloadServer((os.getenv("EXPORT_BIND", "127.0.0.1"), int(os.getenv("EXPORT_PORT", "8090"))), service)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        for sig in (signal.SIGTERM, signal.SIGINT):
            signal.signal(sig, lambda *_: service.stop.set())
        try:
            while not service.stop.is_set():
                try:
                    service.tick()
                except (OSError, ValueError, KeyError):
                    print("EXPORT_STATE_OR_IO_ERROR", flush=True)
                service.stop.wait(1)
        finally:
            service.stop.set()
            if service.worker:
                service.worker.join(30)
            server.shutdown()
            server.server_close()


if __name__ == "__main__":
    main()
