import copy
import http.client
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
import zipfile

from export_service.server import DownloadServer, ExportService, TTL, atomic, byte_range
from export_service.snapshot import Snapshot, safe_open


class ExportTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.root, self.watch, self.control, self.out = [self.base / name for name in ("downloads", "watch", "control", "exports")]
        for path in (self.root, self.watch, self.control, self.out):
            path.mkdir()
        self.now = 1800000000
        sub = {"generation": "generation-1"}
        self.settings = {"version": 1, "ownerId": "1", "allowedIds": ["1", "2", "3"], "users": {"1": {}, "2": {"xTargets": {"alice": sub}}, "3": {"xTargets": {"alice": copy.deepcopy(sub)}}}, "exportRequests": {}}
        self.save_settings()
        self.write("x/alice/media/101_01.mp4", b"video data" * 10)
        self.write("x/alice/posts/101.txt", b"caption")
        self.write("x/alice/posts/101.json", json.dumps({"result": {"contentId": "101", "caption": "hello", "url": "https://x.com/alice/status/101?secret=hidden", "files": [{"relativePath": "x/alice/media/101_01.mp4"}], "kind": "post"}, "event": {"publishedAt": 1700000000, "media": [{"url": "https://cdn.invalid/secret"}]}}).encode())
        self.service = ExportService(self.root, self.watch, self.control, self.out, "https://downloads.example.com", clock=lambda: self.now)
        self.counter = 0

    def write(self, name, data):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)

    def save_settings(self):
        atomic(self.control / "settings.json", self.settings)

    def command(self, action, uid="2", **kwargs):
        self.counter += 1
        command = {"id": f"{uid}-{self.counter}", "userId": uid, "action": action, "platform": "x", "name": "alice", **kwargs}
        self.settings["exportRequests"][command["id"]] = command
        self.save_settings()
        self.service.tick()
        if self.service.worker:
            self.service.worker.join(10)
            self.assertFalse(self.service.worker.is_alive())
        return command

    def ready(self, uid="2"):
        self.command("preview", uid)
        preview = next(key for key, value in self.service.state["previews"].items() if value["userId"] == uid)
        self.command("confirm", uid, preview=preview)
        job = next(j for j in self.service.state["jobs"].values() if uid in j["waiters"])
        self.assertEqual(job["status"], "ready")
        return job, self.token(uid)

    def token(self, uid):
        reports = [r for r in self.service.state["reports"].values() if r["userId"] == uid and r.get("grant")]
        return reports[-1]["text"].split("/files/")[-1]

    def test_zip_manifest_and_private_cache_exclusion(self):
        self.write("x/manual/alice/media/999.mp4", b"private")
        self.write("x/alice/accounts.db", b"private")
        self.write("x/alice/media/unfinished.part.mp4", b"partial")
        job, _ = self.ready()
        with zipfile.ZipFile(self.out / (job["id"] + ".zip")) as archive:
            self.assertIsNone(archive.testzip())
            names = archive.namelist()
            self.assertIn("x/alice/media/101_01.mp4", names)
            self.assertFalse(any("manual" in n or "part.mp4" in n or n.endswith(".db") for n in names))
            manifest = archive.read("export-manifest.json").decode()
            self.assertNotIn("cdn.invalid", manifest)
            self.assertNotIn("secret=", manifest)
            self.assertIn("hello", manifest)
            self.assertEqual(archive.getinfo("x/alice/media/101_01.mp4").extract_version, 45)

    def test_shared_zip_individual_revocation_and_generation(self):
        job, first = self.ready("2")
        expires = job["expires"]
        self.now += 60
        second, token = self.ready("3")
        self.assertEqual(second["id"], job["id"])
        self.assertEqual(second["expires"], expires)
        with self.service.download(first) as (found, stream):
            self.assertIsNotNone(found)
            self.assertTrue(stream.read(4))
        self.settings["users"]["2"]["xTargets"] = {}
        self.save_settings()
        with self.service.download(first) as (found, _):
            self.assertIsNone(found)
        with self.service.download(token) as (found, _):
            self.assertIsNotNone(found)
        self.settings["users"]["2"]["xTargets"]["alice"] = {"generation": "new-generation"}
        self.save_settings()
        with self.service.download(first) as (found, _):
            self.assertIsNone(found)

    def test_expiry_allows_active_transfer_and_defers_deletion(self):
        job, token = self.ready()
        path = self.out / (job["id"] + ".zip")
        with self.service.download(token) as (_, stream):
            self.now += TTL + 1
            self.service.tick()
            self.assertTrue(path.exists())
            self.assertTrue(stream.read())
            with self.service.download(token) as (found, _):
                self.assertIsNone(found)
        self.service.tick()
        self.assertFalse(path.exists())
        self.assertTrue((self.root / "x/alice/media/101_01.mp4").exists())

    def test_cancel_revokes_only_own_link(self):
        _, token = self.ready("2")
        _, other = self.ready("3")
        self.command("cancel")
        with self.service.download(token) as (found, _):
            self.assertIsNone(found)
        with self.service.download(other) as (found, _):
            self.assertIsNotNone(found)

    def test_status_keeps_old_links_valid_and_cancel_preserves_request_acks(self):
        _, original = self.ready()
        command = self.command("status")
        with self.service.download(original) as (found, _):
            self.assertIsNotNone(found)
        self.command("cancel")
        replies = [r for r in self.service.state["reports"].values() if r.get("requestId") == command["id"]]
        self.assertEqual(len(replies), 1)
        self.assertIsNone(replies[0]["grant"])
        self.assertNotIn("/files/", replies[0]["text"])

    def test_unsubscribed_and_forged_confirmation_cannot_export(self):
        self.command("preview")
        preview = next(iter(self.service.state["previews"]))
        self.command("confirm", "3", preview=preview)
        self.assertFalse(self.service.state["jobs"])
        self.settings["users"]["2"]["xTargets"] = {}
        self.save_settings()
        self.command("confirm", preview=preview)
        self.assertFalse(self.service.state["jobs"])

    def test_only_one_pending_per_user_and_shared_work_is_retained(self):
        with patch.object(self.service, "build"):
            self.command("preview")
            preview = next(iter(self.service.state["previews"]))
            self.command("confirm", preview=preview)
            job = next(iter(self.service.state["jobs"].values()))
            self.command("preview", "3")
            other = next(key for key, value in self.service.state["previews"].items() if value["userId"] == "3")
            self.command("confirm", "3", preview=other)
            self.assertEqual(len(self.service.state["jobs"]), 1)
            self.command("cancel")
            self.assertEqual(set(job["waiters"]), {"3"})
            job["status"] = "queued"
            self.assertTrue(self.service.has_waiters(job, self.settings))
            self.settings["users"]["3"]["xTargets"]["bob"] = {"generation": "gen-bob"}
            self.command("preview", "3", name="bob")
            last = list(self.service.state["previews"])[-1]
            self.command("confirm", "3", preview=last)
            self.assertEqual(len(self.service.state["jobs"]), 1)

    def test_missing_file_is_reported_and_symlinks_cannot_escape(self):
        (self.root / "x/alice/media/101_01.mp4").unlink()
        secret = self.base / "secret.mp4"
        secret.write_bytes(b"secret")
        (self.root / "x/alice/media/secret.mp4").symlink_to(secret)
        job, _ = self.ready()
        self.assertGreater(job["missing"], 0)
        with zipfile.ZipFile(self.out / (job["id"] + ".zip")) as archive:
            self.assertNotIn("x/alice/media/secret.mp4", archive.namelist())
            self.assertIn("101_01.mp4", archive.read("缺失清單.txt").decode())
        with self.assertRaises((OSError, ValueError)):
            safe_open(self.root, "../secret.mp4")

    def test_x_media_download_failures_are_incomplete(self):
        self.write("x/alice/posts/102.json", json.dumps({"result": {"files": [], "errors": [{"reason": "X_HTTP_404"}], "contentId": "102"}}).encode())
        snapshot = Snapshot(self.root, self.watch, "x", "alice").collect()
        self.assertTrue(any("102:media-error" in item for item in snapshot["missing"]))

    def test_snapshot_excludes_media_and_metadata_created_after_start(self):
        snapshot = Snapshot(self.root, self.watch, "x", "alice")
        self.write("x/alice/media/102_01.mp4", b"new video")
        self.write("x/alice/posts/102.txt", b"new caption")
        self.write("x/alice/posts/102.json", json.dumps({"result": {"contentId": "102", "files": [{"relativePath": "x/alice/media/102_01.mp4"}]}}).encode())
        result = snapshot.collect()
        self.assertFalse(any("102" in f["path"] for f in result["files"]))
        self.assertFalse(any(record["id"] == "102" for record in result["records"]))

    def test_disk_space_failure_preserves_archives(self):
        self.command("preview")
        preview = next(iter(self.service.state["previews"]))
        with patch("export_service.server.shutil.disk_usage", return_value=type("Usage", (), {"free": 1})()):
            self.command("confirm", preview=preview)
        job = next(iter(self.service.state["jobs"].values()))
        self.assertEqual(job["status"], "failed")
        self.assertTrue((self.root / "x/alice/media/101_01.mp4").exists())
        self.assertFalse(list(self.out.glob("*.part")))

    def test_restart_requeues_and_keeps_ready_links(self):
        job, token = self.ready()
        pending = copy.deepcopy(job)
        pending.update(id="a" * 24, status="building", waiters={"3": {"generation": "generation-1"}})
        self.service.state["jobs"][pending["id"]] = pending
        self.service.persist()
        restarted = ExportService(self.root, self.watch, self.control, self.out, self.service.base_url, clock=lambda: self.now)
        self.assertEqual(restarted.state["jobs"][pending["id"]]["status"], "queued")
        with restarted.download(token) as (found, _):
            self.assertEqual(found["id"], job["id"])

    def test_http_ranges_head_and_no_public_directory(self):
        job, token = self.ready()
        server = DownloadServer(("127.0.0.1", 0), self.service)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        connection = http.client.HTTPConnection(*server.server_address)
        self.addCleanup(connection.close)
        connection.request("GET", "/files/" + token, headers={"Range": "bytes=0-3"})
        response = connection.getresponse()
        self.assertEqual(response.status, 206)
        self.assertEqual(response.read(), b"PK\x03\x04")
        self.assertIn("no-store", response.headers["Cache-Control"])
        connection.request("HEAD", "/files/" + token)
        response = connection.getresponse()
        self.assertEqual(response.status, 200)
        self.assertEqual(int(response.headers["Content-Length"]), job["bytes"])
        response.read()
        for path in ("/files/", "/state.json", "/files/../../settings.json", "/files/" + "a" * 43):
            connection.request("GET", path)
            response = connection.getresponse()
            self.assertEqual(response.status, 404)
            response.read()
        with self.assertRaises(ValueError):
            byte_range("bytes=0-1,3-4", 100)

    def test_instagram_and_tiktok_snapshots(self):
        atomic(self.watch / "archive-layout.json", {"accounts": {"123": "alice"}})
        atomic(self.watch / "archive-123.json", {"saved": {"789": {"relativePath": "stories/20260101_120000_JST_789.mp4"}}})
        self.write("instagram/alice/stories/20260101_120000_JST_789.mp4", b"story")
        self.write("instagram/manual/alice/999.mp4", b"manual")
        snap = Snapshot(self.root, self.watch, "ig", "alice").collect()
        self.assertEqual(len(snap["files"]), 1)
        self.assertEqual(snap["records"][0]["publishedAtJST"], "20260101_120000")
        self.write("tiktok/alice/live/final.mp4", b"recording")
        self.write("tiktok/alice/live/active_flv.mp4", b"unfinished")
        self.write("tiktok/alice/live/working.mp4", b"working")
        (self.watch / "tiktok/processing").mkdir(parents=True)
        atomic(self.watch / "tiktok/processing/active.json", {"username": "alice", "dest": "/downloads/tiktok/alice/live/working.mp4"})
        snap = Snapshot(self.root, self.watch, "tt", "alice").collect()
        self.assertEqual([f["path"] for f in snap["files"]], ["tiktok/alice/live/final.mp4"])


if __name__ == "__main__":
    unittest.main()
