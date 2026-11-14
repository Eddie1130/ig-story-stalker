import json
import errno
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch
from types import SimpleNamespace
import shutil
import subprocess

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tiktok"))
from catalog_provider import (
    ProviderError,
    checked_page,
    media_url,
    normalize,
    normalize_page,
)
from catalog_worker import Catalog, download, SessionProvider
from catalog_regular_browser import RegularBrowserTransport
from catalog_browser import BrowserTransport
from catalog_login import prepare_profile
from catalog_media import delivery_parts


class CatalogTests(unittest.TestCase):
    def test_archived_payloads_are_not_loaded_for_idle_work_or_health(self):
        record = {"username": "alice", "kind": "post", "status": "ready", "raw": "x" * 10000}
        self.catalog.db.executemany(
            "INSERT INTO items VALUES(?,?,?,?)",
            [("123", "post", str(i), json.dumps(record)) for i in range(100)],
        )
        self.catalog.db.commit()
        with patch("catalog_worker.json.loads", wraps=json.loads) as loads:
            self.catalog.drain(self.settings)
            self.catalog.repair(self.settings)
            self.catalog.health()
            self.assertEqual(loads.call_count, 0)

    def test_reader_page_closes_restored_tabs_and_future_popups(self):
        browser = BrowserTransport.__new__(BrowserTransport)
        browser.context = Mock()
        old = [Mock(), Mock(), Mock()]
        current = browser.context.new_page.return_value
        browser.context.pages = old + [current]
        browser.prepare_reader_page()
        for page in old:
            page.close.assert_called_once()
        current.close.assert_not_called()
        popup = Mock()
        callback = browser.context.on.call_args.args[1]
        callback(popup)
        popup.close.assert_called_once()
        callback(current)
        current.close.assert_not_called()

    def test_reader_blocks_heavy_assets_but_keeps_scripts_and_catalog_api(self):
        for resource, blocked in [("image", True), ("media", True), ("font", True), ("script", False), ("fetch", False)]:
            route = Mock()
            route.request = SimpleNamespace(method="GET", url="https://www.tiktok.com/asset", resource_type=resource)
            BrowserTransport.guard(route)
            self.assertEqual(route.abort.called, blocked)

    def test_session_recycles_aged_browser_and_keeps_one_transport(self):
        old, replacement = Mock(), Mock()
        with patch("catalog_regular_browser.RegularBrowserTransport", side_effect=[old, replacement]) as launch, patch(
            "catalog_worker.cookies", return_value={}
        ), patch("catalog_provider.fetch_page", return_value={"items": []}), patch(
            "catalog_worker.time.monotonic", side_effect=[10, 20, 3610, 3610]
        ), patch.dict("os.environ", {"TIKTOK_CATALOG_BROWSER_MAX_AGE_SECONDS": "3600"}):
            session = SessionProvider()
            session("alice", "post")
            session("alice", "repost")
            self.assertEqual(launch.call_count, 1)
            session("alice", "story")
            old.close.assert_called_once()
            self.assertIs(session.browser, replacement)
            self.assertEqual(launch.call_count, 2)
            session.close()

    def test_reader_freezes_only_between_fetches_and_resumes_before_navigation(self):
        browser = Mock()
        operations = []
        browser.resume.side_effect = lambda: operations.append("resume")
        browser.pause.side_effect = lambda: operations.append("pause")
        browser.navigate.side_effect = lambda name: operations.append("navigate")
        with patch("catalog_regular_browser.RegularBrowserTransport", return_value=browser), patch(
            "catalog_worker.cookies", return_value={}
        ), patch("catalog_provider.fetch_page", side_effect=lambda *_: operations.append("fetch") or {"items": []}):
            session = SessionProvider()
            session("alice", "post")
            session("bob", "story")
        self.assertEqual(operations, ["fetch", "pause", "resume", "navigate", "fetch", "pause"])

    def test_regular_page_lifecycle_freeze_can_be_resumed(self):
        browser = RegularBrowserTransport.__new__(RegularBrowserTransport)
        browser.lifecycle = Mock()
        browser.pause()
        browser.resume()
        self.assertEqual(
            [(c.args[0], c.args[1]) for c in browser.lifecycle.send.call_args_list],
            [("Emulation.setScriptExecutionDisabled", {"value": True}), ("Emulation.setScriptExecutionDisabled", {"value": False})],
        )

    def test_idle_releases_renderer_once_then_reloads_target_for_next_work(self):
        browser = Mock()
        with patch("catalog_regular_browser.RegularBrowserTransport", return_value=browser), patch(
            "catalog_worker.cookies", return_value={}
        ), patch("catalog_provider.fetch_page", return_value={"items": []}):
            session = SessionProvider()
            session("alice", "post")
            session.idle()
            session.idle()
            browser.park.assert_called_once()
            self.assertIsNone(session.name)
            session("alice", "story")
            browser.navigate.assert_called_once_with("alice")
            session.close()

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.time = 10000
        self.settings = {
            "version": 1,
            "allowedIds": ["100", "200"],
            "users": {
                uid: {
                    "tiktokTargets": {
                        "alice": {
                            "generation": uid,
                            "joinedAt": 1000,
                            "notifications": {
                                kind: {"enabled": True, "since": 1000}
                                for kind in ("post", "repost", "story", "profile")
                            },
                        }
                    }
                }
                for uid in ("100", "200")
            },
        }
        self.fetch = Mock()

        def download(url, file, kind):
            file.parent.mkdir(parents=True, exist_ok=True)
            dest = file.with_suffix(".mp4" if kind == "video" else ".jpg")
            dest.write_bytes(
                b"\x00\x00\x00\x18ftypisom" + b"x" * 5000
                if kind == "video"
                else b"\xff\xd8\xff" + b"x" * 32
            )
            return dest

        self.download = Mock(side_effect=download)
        self.catalog = Catalog(
            root / "downloads",
            root / "state",
            root / "control",
            self.fetch,
            self.download,
            lambda: self.time,
        )
        self.addCleanup(self.catalog.db.close)

    def notices(self):
        return [json.loads(data) for (data,) in self.catalog.db.execute("SELECT data FROM outbox")
                if json.loads(data).get("kind") == "notice"]

    def test_transient_poll_notifies_only_third_failure_and_recovery(self):
        self.fetch.side_effect = RuntimeError("TIKTOK_PROVIDER_TIMEOUT")
        for attempt in range(1, 5):
            self.catalog.poll("alice", "post", self.settings)
            state = self.catalog.stream("alice", "post")
            self.catalog.health()
            health = json.loads((self.catalog.folder / "health.json").read_text())
            self.assertEqual(bool(health["targets"]["alice"]["post"]["failures"]), attempt >= 3)
            self.assertEqual(len(self.notices()), int(attempt >= 3))
            self.time = state["nextAt"]
        self.fetch.side_effect = None
        self.fetch.return_value = self.page()
        self.catalog.poll("alice", "post", self.settings)
        self.assertEqual(len(self.notices()), 2)

    def test_two_transient_poll_failures_recover_silently_and_reset(self):
        self.fetch.side_effect = RuntimeError("TIKTOK_PROVIDER_TIMEOUT")
        for _ in range(2):
            self.catalog.poll("alice", "post", self.settings)
            self.time = self.catalog.stream("alice", "post")["nextAt"]
        self.fetch.side_effect = None
        self.fetch.return_value = self.page()
        self.catalog.poll("alice", "post", self.settings)
        self.assertEqual(self.notices(), [])
        self.time = self.catalog.stream("alice", "post")["nextAt"]
        self.fetch.side_effect = RuntimeError("TIKTOK_PROVIDER_TIMEOUT")
        self.catalog.poll("alice", "post", self.settings)
        self.assertEqual(self.notices(), [])

    def test_archive_waits_three_failures_before_notifying(self):
        self.fetch.return_value = self.page()
        self.catalog.poll("alice", "post", self.settings)
        self.download.side_effect = TimeoutError()
        for attempt in range(1, 5):
            self.catalog.drain(self.settings)
            self.assertEqual(len(self.notices()), int(attempt >= 3))
            self.time = self.records()[0]["retryAt"]

    def test_captcha_still_alerts_immediately(self):
        self.fetch.side_effect = RuntimeError("TIKTOK_CAPTCHA_REQUIRED")
        self.catalog.poll("alice", "post", self.settings)
        self.assertEqual(len(self.notices()), 1)
        self.catalog.health()
        health = json.loads((self.catalog.folder / "health.json").read_text())
        self.assertEqual(health["targets"]["alice"]["post"]["failures"], 1)

    def test_real_download_disk_full_is_not_masked_as_a_transient_network_error(self):
        self.fetch.return_value = self.page()
        self.catalog.poll("alice", "post", self.settings)
        self.download.side_effect = OSError(errno.ENOSPC, "disk full")
        self.catalog.drain(self.settings)
        self.assertEqual(len(self.notices()), 1)
        self.assertTrue(self.records()[0]["archiveAlerted"])

    def test_unresolved_content_waits_three_repairs_and_recovers_only_after_alert(self):
        self.fetch.return_value = self.page("repost", rows=[self.unresolved()])
        self.catalog.poll("alice", "repost", self.settings)
        self.assertEqual(self.notices(), [])
        self.fetch.side_effect = RuntimeError("TIKTOK_ITEM_UNAVAILABLE")
        for attempt in range(1, 5):
            self.catalog.repair(self.settings)
            self.assertEqual(len(self.notices()), int(attempt >= 3))
            self.time = self.records()[0]["retryAt"]
        self.fetch.side_effect = None
        self.fetch.return_value = {"items": [self.row("2")]}
        self.catalog.repair(self.settings)
        self.assertEqual(len(self.notices()), 2)

    def test_pending_poll_failure_count_survives_reopening_database(self):
        self.fetch.side_effect = RuntimeError("TIKTOK_PROVIDER_TIMEOUT")
        for _ in range(2):
            self.catalog.poll("alice", "post", self.settings)
            self.time = self.catalog.stream("alice", "post")["nextAt"]
        restarted = Catalog(self.catalog.root, self.catalog.state_dir, self.catalog.control,
                            self.fetch, self.download, lambda: self.time)
        self.addCleanup(restarted.db.close)
        restarted.poll("alice", "post", self.settings)
        self.assertEqual(restarted.stream("alice", "post")["failures"], 3)
        self.assertEqual(len(self.notices()), 1)

    def row(self, iid="1", caption="caption"):
        return {
            "id": iid,
            "authorId": "10",
            "author": "alice",
            "caption": caption,
            "publishedAt": 1,
            "assets": [{"type": "video", "url": "https://v.tiktokcdn.com/test.mp4"}],
        }

    def page(self, kind="post", rows=None, more=False, cursor="0", uid="10"):
        return {
            "version": 1,
            "userId": uid,
            "username": "alice",
            "kind": kind,
            "items": rows if rows is not None else [self.row()],
            "hasMore": more,
            "cursor": cursor,
        }

    def records(self):
        return [
            json.loads(row[0])
            for row in self.catalog.db.execute("SELECT data FROM items")
        ]

    def test_initial_baseline_all_pages_quiet_then_new_post_notifies_both(self):
        self.fetch.return_value = self.page(more=True, cursor="2")
        self.catalog.poll("alice", "post", self.settings)
        self.assertFalse(self.catalog.stream("alice", "post")["baseline"])
        self.time += 30001
        self.fetch.return_value = self.page(rows=[self.row("2")])
        self.catalog.poll("alice", "post", self.settings)
        self.assertTrue(self.catalog.stream("alice", "post")["baseline"])
        self.assertTrue(all(not r["recipients"] for r in self.records()))
        self.time += 300001
        self.fetch.return_value = self.page(rows=[self.row("3"), self.row("1")])
        self.catalog.poll("alice", "post", self.settings)
        self.assertEqual(len(self.records()[-1]["recipients"]), 2)
        self.catalog.drain(self.settings)
        self.catalog.flush()
        events = [
            json.loads(f.read_text())
            for f in (self.catalog.state_dir / "tiktok/events").glob("*.json")
        ]
        self.assertEqual(sum(bool(e["recipients"]) for e in events), 1)

    def test_story_first_scan_eligible_disable_does_not_disable_archive(self):
        self.settings["users"]["200"]["tiktokTargets"]["alice"]["notifications"][
            "story"
        ]["enabled"] = False
        self.fetch.return_value = self.page("story")
        self.catalog.poll("alice", "story", self.settings)
        record = self.records()[0]
        self.assertEqual([r["userId"] for r in record["recipients"]], ["100"])
        self.catalog.drain(self.settings)
        self.assertEqual(self.records()[0]["status"], "ready")

    def test_error_preserves_baseline_and_history_and_other_kind_independent(self):
        self.fetch.return_value = self.page()
        self.catalog.poll("alice", "post", self.settings)
        self.time += 300001
        self.fetch.side_effect = RuntimeError("TIKTOK_RESPONSE_INVALID")
        self.catalog.poll("alice", "post", self.settings)
        state = self.catalog.stream("alice", "post")
        self.assertTrue(state["baseline"])
        self.assertEqual(state["failures"], 1)
        self.assertEqual(len(self.records()), 1)
        self.assertFalse(self.catalog.stream("alice", "story")["baseline"])

    def test_repost_old_original_is_new_activity_and_shared_download(self):
        self.fetch.return_value = self.page()
        self.catalog.poll("alice", "post", self.settings)
        self.fetch.return_value = self.page("repost", rows=[])
        self.catalog.poll("alice", "repost", self.settings)
        self.time += 300001
        self.fetch.return_value = self.page("repost")
        self.catalog.poll("alice", "repost", self.settings)
        self.assertEqual(len(self.records()[1]["recipients"]), 2)
        self.catalog.drain(self.settings)
        self.assertEqual(self.download.call_count, 1)
        self.assertEqual(self.records()[0]["files"][0].split("/")[-1], "01.mp4")

    def test_new_subscriber_gets_active_story_without_resending_to_original(self):
        original = self.settings["users"]["200"]["tiktokTargets"].pop("alice")
        self.fetch.return_value = self.page("story")
        self.catalog.poll("alice", "story", self.settings)
        self.catalog.drain(self.settings)
        self.catalog.flush()
        self.settings["users"]["200"]["tiktokTargets"]["alice"] = original
        self.time += 120001
        self.catalog.poll("alice", "story", self.settings)
        self.catalog.flush()
        events = [
            json.loads(f.read_text())
            for f in (self.catalog.state_dir / "tiktok/events").glob("*.json")
        ]
        self.assertEqual(
            sorted([r["userId"] for e in events for r in e["recipients"]]),
            ["100", "200"],
        )

    def test_pending_story_new_subscriber_uses_new_event_timestamp(self):
        new_sub = self.settings["users"]["200"]["tiktokTargets"].pop("alice")
        self.fetch.return_value = self.page("story")
        self.catalog.poll("alice", "story", self.settings)
        self.time += 120001
        new_sub["joinedAt"] = self.time
        new_sub["notifications"]["story"]["since"] = self.time
        self.settings["users"]["200"]["tiktokTargets"]["alice"] = new_sub
        self.catalog.poll("alice", "story", self.settings)
        self.catalog.drain(self.settings)
        self.catalog.flush()
        events = [
            json.loads(f.read_text())
            for f in (self.catalog.state_dir / "tiktok/events").glob("*.json")
        ]
        delivered = [(r["userId"], e["at"]) for e in events for r in e["recipients"]]
        self.assertIn(("100", 10000), delivered)
        self.assertIn(("200", new_sub["joinedAt"]), delivered)
        self.assertEqual(len(delivered), 2)

    def test_profile_revert_is_a_distinct_change(self):
        def page(nickname):
            return {
                "version": 1,
                "userId": "10",
                "username": "alice",
                "kind": "profile",
                "profile": {
                    "id": "10",
                    "username": "alice",
                    "nickname": nickname,
                    "bio": "bio",
                    "avatarKey": "/a.jpg",
                },
                "avatar": "https://p.tiktokcdn.com/a.jpg",
            }

        for nickname in ["A", "B", "A"]:
            self.fetch.return_value = page(nickname)
            self.catalog.poll("alice", "profile", self.settings)
            self.time += 1800001
        self.assertEqual(len(self.records()), 3)
        self.assertEqual(sum(bool(r["recipients"]) for r in self.records()), 2)

    def test_retry_refreshes_urls_without_changing_recipients_or_observed_time(self):
        self.fetch.return_value = self.page("story")
        self.catalog.poll("alice", "story", self.settings)
        self.download.side_effect = RuntimeError("expired")
        self.catalog.drain(self.settings)
        before = self.records()[0]
        self.time += 60001
        fresh = self.row()
        fresh["assets"][0]["url"] = "https://v.tiktokcdn.com/fresh.mp4"
        self.fetch.return_value = {"items": [fresh]}
        self.catalog.drain(self.settings)
        record = self.records()[0]
        self.assertEqual(
            record["item"]["assets"][0]["url"], "https://v.tiktokcdn.com/fresh.mp4"
        )
        self.assertEqual(record["recipients"], before["recipients"])
        self.assertEqual(record["at"], before["at"])

    def test_caption_edits_update_local_text_without_new_event(self):
        self.fetch.return_value = self.page()
        self.catalog.poll("alice", "post", self.settings)
        self.catalog.drain(self.settings)
        self.catalog.flush()
        self.time += 300001
        self.fetch.return_value = self.page(rows=[self.row(caption="edited")])
        self.catalog.poll("alice", "post", self.settings)
        self.assertEqual(
            (self.catalog.root / "tiktok/alice/posts/1/caption.txt").read_text(),
            "edited",
        )
        self.assertEqual(
            self.catalog.db.execute("SELECT count(*) FROM outbox").fetchone()[0], 0
        )

    def test_last_unsubscribe_stops_pending_work_and_keeps_history(self):
        self.fetch.return_value = self.page()
        self.catalog.poll("alice", "post", self.settings)
        for user in self.settings["users"].values():
            user["tiktokTargets"] = {}
        self.catalog.drain(self.settings)
        self.download.assert_not_called()
        self.assertEqual(len(self.records()), 1)

    def test_download_tries_valid_alternatives_and_preserves_browser_headers(self):
        asset = {
            "url": "https://a.tiktokcdn.com/a.mp4",
            "urls": ["https://a.tiktokcdn.com/a.mp4", "https://b.tiktokcdn.com/a.mp4"],
            "type": "video",
            "headers": {
                "User-Agent": "Browser UA",
                "Referer": "https://www.tiktok.com/",
            },
        }
        destination = self.catalog.root / "sample"
        saved = destination.with_suffix(".mp4")
        self.download.side_effect = [RuntimeError("403"), saved]
        self.assertEqual(self.catalog.download_asset(asset, destination), saved)
        self.assertEqual(
            [call.args[0] for call in self.download.call_args_list], asset["urls"]
        )
        self.assertEqual(
            self.download.call_args.kwargs["headers"]["User-Agent"], "Browser UA"
        )

    def unresolved(self, iid="2"):
        row = self.row(iid)
        row.update(
            assets=[],
            unresolvedReason="TIKTOK_VIDEO_URL_MISSING",
            raw={"id": iid, "video": {"duration": 5}},
        )
        return row

    def test_partial_page_advances_and_archives_valid_items_without_losing_bad_record(
        self,
    ):
        self.fetch.return_value = self.page(
            "repost", rows=[self.row("1"), self.unresolved("2")], more=True, cursor="2"
        )
        self.catalog.poll("alice", "repost", self.settings)
        state = self.catalog.stream("alice", "repost")
        self.assertEqual(state["cursor"], "2")
        self.assertEqual(state["failures"], 0)
        records = {r["item"]["id"]: r for r in self.records()}
        self.assertEqual(records["2"]["status"], "unresolved")
        self.assertEqual(records["2"]["item"]["raw"]["video"], {"duration": 5})
        self.catalog.drain(self.settings)
        records = {r["item"]["id"]: r for r in self.records()}
        self.assertEqual(records["1"]["status"], "ready")
        self.assertEqual(records["2"]["status"], "unresolved")
        self.catalog.health()
        h = json.loads((self.catalog.folder / "health.json").read_text())
        self.assertEqual(h["unresolved"], 1)
        self.assertIn("待補查", h["targets"]["alice"]["repost"]["phase"])

    def test_unresolved_retry_survives_restart_and_preserves_silent_baseline(self):
        self.fetch.return_value = self.page("repost", rows=[self.unresolved()])
        self.catalog.poll("alice", "repost", self.settings)
        before = self.records()[0]
        self.fetch.side_effect = RuntimeError("TIKTOK_ITEM_UNAVAILABLE")
        self.catalog.repair(self.settings)
        self.assertEqual(self.records()[0]["status"], "unresolved")
        self.assertGreater(self.records()[0]["retryAt"], self.time)
        self.catalog.db.close()
        restarted = Catalog(
            self.catalog.root,
            self.catalog.state_dir,
            self.catalog.control,
            self.fetch,
            self.download,
            lambda: self.time,
        )
        self.addCleanup(restarted.db.close)
        self.time += 120001
        self.fetch.side_effect = None
        self.fetch.return_value = {"version": 1, "items": [self.row("2")]}
        restarted.repair(self.settings)
        restarted.drain(self.settings)
        record = json.loads(
            restarted.db.execute("SELECT data FROM items").fetchone()[0]
        )
        self.assertEqual(record["status"], "ready")
        self.assertEqual(record["at"], before["at"])
        self.assertEqual(record["recipients"], [])
        self.assertNotIn("raw", record["item"])

    def test_bad_refresh_does_not_downgrade_an_already_archived_item(self):
        self.fetch.return_value = self.page()
        self.catalog.poll("alice", "post", self.settings)
        self.catalog.drain(self.settings)
        before = self.records()[0]
        self.time += 300001
        self.fetch.return_value = self.page(rows=[self.unresolved("1")])
        self.catalog.poll("alice", "post", self.settings)
        after = self.records()[0]
        self.assertEqual(after["status"], "ready")
        self.assertEqual(after["files"], before["files"])
        self.assertEqual(after["item"]["assets"], before["item"]["assets"])

    def test_unresolved_new_activity_keeps_original_recipients_and_retry_deadline(self):
        self.fetch.return_value = self.page("repost", rows=[])
        self.catalog.poll("alice", "repost", self.settings)
        self.time += 300001
        self.fetch.return_value = self.page("repost", rows=[self.unresolved()])
        self.catalog.poll("alice", "repost", self.settings)
        before = self.records()[0]
        self.assertEqual(len(before["recipients"]), 2)
        self.fetch.side_effect = RuntimeError("TIKTOK_ITEM_UNAVAILABLE")
        self.catalog.repair(self.settings)
        calls = self.fetch.call_count
        self.catalog.repair(self.settings)
        self.assertEqual(self.fetch.call_count, calls)
        self.time += 120001
        self.fetch.side_effect = None
        self.fetch.return_value = {"version": 1, "items": [self.row("2")]}
        self.catalog.repair(self.settings)
        after = self.records()[0]
        self.assertEqual(after["status"], "pending")
        self.assertEqual(after["recipients"], before["recipients"])
        self.assertEqual(after["at"], before["at"])

    def test_new_account_media_is_local_and_cross_account_repost_deduplicates(self):
        import copy

        self.settings["users"]["100"]["tiktokTargets"]["bob"] = copy.deepcopy(
            self.settings["users"]["100"]["tiktokTargets"]["alice"]
        )
        self.fetch.return_value = self.page()
        self.catalog.poll("alice", "post", self.settings)
        self.fetch.return_value = {**self.page("repost", uid="20"), "username": "bob"}
        self.catalog.poll("bob", "repost", self.settings)
        self.catalog.drain(self.settings)
        alice = self.catalog.root / "tiktok/alice/media/1_01.mp4"
        bob = self.catalog.root / "tiktok/bob/media/1_01.mp4"
        self.assertTrue(alice.exists())
        self.assertTrue(bob.exists())
        self.assertTrue(alice.samefile(bob))
        self.assertEqual(self.download.call_count, 1)
        self.assertFalse((self.catalog.root / "tiktok/media").exists())
        for record in self.records():
            self.assertTrue((self.catalog.root / record["files"][0]).exists())

    def test_marker_prevents_missing_history_replacement(self):
        file = self.catalog.folder / "catalog.sqlite"
        file.unlink()
        with self.assertRaisesRegex(RuntimeError, "HISTORY_MISSING"):
            Catalog(self.catalog.root, self.catalog.state_dir, self.catalog.control)

    def test_reused_username_does_not_silently_switch_account_identity(self):
        self.fetch.return_value = self.page()
        self.catalog.poll("alice", "post", self.settings)
        self.time += 300001
        self.fetch.return_value = self.page(uid="99", rows=[self.row("99")])
        self.catalog.poll("alice", "post", self.settings)
        self.assertEqual(
            self.catalog.stream("alice", "post")["reason"], "TIKTOK_ACCOUNT_ID_CHANGED"
        )
        self.assertEqual(len(self.records()), 1)

    def test_repeated_cursor_and_bad_identity_are_failed_not_empty(self):
        self.fetch.return_value = self.page(more=True, cursor="0")
        self.catalog.poll("alice", "post", self.settings)
        self.assertEqual(self.catalog.stream("alice", "post")["failures"], 1)
        self.assertEqual(self.records(), [])


class ProviderTests(unittest.TestCase):
    def test_page_normalizes_good_rows_and_quarantines_only_bad_media(self):
        ex = Mock()
        ex.catalog_headers = {}
        ex._extract_video_urls.side_effect = lambda v: (
            [v["playAddr"]] if v.get("playAddr") else []
        )
        good = {
            "id": "1",
            "author": {"id": "10", "uniqueId": "alice"},
            "createTime": 1,
            "desc": "good",
            "video": {"playAddr": "https://v.tiktokcdn.com/a.mp4"},
        }
        bad = {
            "id": "2",
            "author": {"id": "10", "uniqueId": "alice"},
            "createTime": 1,
            "desc": "bad",
            "video": {"duration": 5},
        }
        rows = normalize_page([good, bad], ex)
        self.assertEqual(len(rows), 2)
        self.assertEqual(len(rows[0]["assets"]), 1)
        self.assertEqual(rows[1]["unresolvedReason"], "TIKTOK_VIDEO_URL_MISSING")
        self.assertEqual(rows[1]["raw"], bad)
        self.assertEqual(rows[1]["id"], "2")
        with self.assertRaises(ProviderError):
            normalize_page([{"video": {"duration": 5}}], ex)

    def test_session_provider_recovers_crashed_page_that_is_not_closed(self):
        browser = Mock()
        browser.page.is_closed.return_value = False
        with patch(
            "catalog_regular_browser.RegularBrowserTransport", return_value=browser
        ), patch("catalog_worker.cookies", return_value={}), patch(
            "catalog_provider.fetch_page",
            side_effect=RuntimeError("Page.goto: Page crashed"),
        ):
            session = SessionProvider()
            with self.assertRaisesRegex(RuntimeError, "TRANSPORT_FAILED"):
                session("alice", "post")
            browser.close.assert_called_once()
            self.assertIsNone(session.browser)

    def test_regular_context_bypasses_and_unregisters_tiktok_service_workers(self):
        browser = RegularBrowserTransport.__new__(RegularBrowserTransport)
        browser.context, browser.page = Mock(), Mock()
        cdp = browser.context.new_cdp_session.return_value
        browser.lifecycle = cdp

        def registrations(event, handler):
            handler(
                {
                    "registrations": [
                        {"scopeURL": "https://www.tiktok.com/"},
                        {"scopeURL": "https://accounts.google.com/"},
                    ]
                }
            )

        cdp.on.side_effect = registrations
        browser.guard_workers()
        self.assertIn(
            ("Network.setBypassServiceWorker", {"bypass": True}),
            [
                (c.args[0], c.args[1])
                for c in cdp.send.call_args_list
                if len(c.args) == 2
            ],
        )
        scopes = [
            c.args[1]["scopeURL"]
            for c in cdp.send.call_args_list
            if c.args[0] == "ServiceWorker.unregister"
        ]
        self.assertEqual(scopes, ["https://www.tiktok.com/"])
        self.assertIn(
            "ServiceWorkerContainer.prototype.register",
            browser.context.add_init_script.call_args.args[0],
        )

    def test_session_provider_recovers_closed_browser_without_captcha_retry(self):
        browser, replacement = Mock(), Mock()
        browser.page.is_closed.return_value = True
        with patch(
            "catalog_regular_browser.RegularBrowserTransport",
            side_effect=[browser, replacement],
        ), patch("catalog_worker.cookies", return_value={}), patch(
            "catalog_provider.fetch_page",
            side_effect=[RuntimeError("browser has been closed"), {"items": []}],
        ):
            session = SessionProvider()
            with self.assertRaisesRegex(RuntimeError, "TRANSPORT_FAILED"):
                session("alice", "post")
            browser.close.assert_called_once()
            self.assertIsNone(session.browser)
            self.assertEqual(session("alice", "post"), {"items": []})
            self.assertIs(session.browser, replacement)
            session.close()

    def test_session_provider_reuses_browser_and_stops_requests_after_captcha(self):
        browser = Mock()
        with patch(
            "catalog_regular_browser.RegularBrowserTransport", return_value=browser
        ) as launch, patch("catalog_worker.cookies", return_value={}), patch(
            "catalog_provider.fetch_page", return_value={"items": []}
        ) as fetch:
            session = SessionProvider()
            session("alice", "post")
            session("alice", "repost")
            launch.assert_called_once()
            browser.navigate.assert_not_called()
            session("bob", "post")
            browser.navigate.assert_called_once_with("bob")
            fetch.side_effect = RuntimeError("TIKTOK_CAPTCHA_REQUIRED")
            with self.assertRaisesRegex(RuntimeError, "CAPTCHA"):
                session("bob", "story")
            before = fetch.call_count
            with self.assertRaisesRegex(RuntimeError, "CAPTCHA"):
                session("alice", "post")
            self.assertEqual(fetch.call_count, before)
            session.close()
            browser.close.assert_called_once()

    def test_asset_cookie_headers_are_never_forwarded(self):
        session, response = Mock(), Mock()
        response.status_code = 200
        response.iter_content.return_value = [b"\x00\x00\x00\x18ftypisom" + b"x" * 20]
        session.get.return_value = response
        with tempfile.TemporaryDirectory() as folder:
            file = download(
                "https://v.tiktokcdn.com/a.mp4",
                Path(folder) / "sample",
                "video",
                session,
                headers={"Cookie": "never-forward", "User-Agent": "Browser UA"},
            )
            self.assertEqual(file.suffix, ".mp4")
        self.assertNotIn("Cookie", session.get.call_args.kwargs["headers"])
        self.assertEqual(
            session.get.call_args.kwargs["headers"]["User-Agent"], "Browser UA"
        )

    def test_browser_guard_rejects_writes_and_unexpected_api(self):
        for method, path, blocked in [
            ("POST", "/api/story/item_list/", True),
            ("GET", "/api/story/view/", True),
            ("GET", "/api/story/item_list/", False),
        ]:
            route = Mock()
            route.request = SimpleNamespace(
                method=method, url="https://www.tiktok.com" + path
            )
            BrowserTransport.guard(route)
            self.assertEqual(route.abort.called, blocked)
            self.assertEqual(route.continue_.called, not blocked)

    def test_automated_reader_preserves_manually_prepared_session(self):
        factory, engine, context = Mock(), Mock(), Mock()
        factory.start.return_value = engine
        engine.chromium.launch_persistent_context.return_value = context
        context.pages = []
        with tempfile.TemporaryDirectory() as folder:
            profile = Path(folder)
            values = {"example": "test-cookie-value"}
            prepare_profile(profile, values)
            with patch.dict(
                "os.environ", {"TIKTOK_CATALOG_PROFILE": str(profile)}
            ), patch.dict(
                sys.modules,
                {
                    "playwright.sync_api": SimpleNamespace(
                        sync_playwright=lambda: factory
                    )
                },
            ):
                browser = BrowserTransport("alice", values)
                context.add_cookies.assert_not_called()
                route = Mock()
                handler = context.route_web_socket.call_args.args[1]
                handler(route)
                route.close.assert_not_called()
                route.connect_to_server.assert_not_called()
                browser.close()
        self.assertEqual(
            engine.chromium.launch_persistent_context.call_args.kwargs[
                "service_workers"
            ],
            "block",
        )

    def test_failed_browser_initialization_closes_resources(self):
        transport = BrowserTransport.__new__(BrowserTransport)
        engine, context = Mock(), Mock()

        def fail(*_):
            transport.engine, transport.context = engine, context
            raise RuntimeError("failed navigation")

        with patch.object(BrowserTransport, "open", side_effect=fail):
            with self.assertRaises(RuntimeError):
                transport.__init__("alice", {})
        engine.stop.assert_called_once()
        context.close.assert_called_once()

    def test_failed_http_download_closes_response_and_redirect_rejects_private_host(
        self,
    ):
        session, response = Mock(), Mock()
        session.get.return_value = response
        response.status_code = 403
        response.raise_for_status.side_effect = RuntimeError("403")
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaises(RuntimeError):
                download(
                    "https://v.tiktokcdn.com/a.mp4",
                    Path(folder) / "x",
                    "video",
                    session,
                )
        response.close.assert_called_once()
        session, response = Mock(), Mock()
        session.get.return_value = response
        response.status_code = 302
        response.headers = {"Location": "http://127.0.0.1/private"}
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaises(ProviderError):
                download(
                    "https://v.tiktokcdn.com/a.mp4",
                    Path(folder) / "x",
                    "video",
                    session,
                )
        self.assertEqual(session.get.call_count, 1)

    @unittest.skipUnless(shutil.which("ffmpeg"), "ffmpeg unavailable")
    def test_catalog_split_keeps_full_video_and_caps_delivery_parts(self):
        with tempfile.TemporaryDirectory() as folder:
            file = Path(folder) / "test.mp4"
            subprocess.run(
                [
                    "ffmpeg",
                    "-v",
                    "error",
                    "-f",
                    "lavfi",
                    "-i",
                    "testsrc=size=128x128:rate=10",
                    "-t",
                    "10",
                    "-c:v",
                    "mpeg4",
                    "-g",
                    "5",
                    str(file),
                ],
                check=True,
            )
            original = file.stat().st_size
            parts = delivery_parts(file, limit=50000)
            self.assertEqual(file.stat().st_size, original)
            self.assertGreater(len(parts), 1)
            self.assertTrue(all(p.stat().st_size <= 50000 for p in parts))

    def test_strict_empty_page_and_rejected_or_incomplete_payload(self):
        self.assertEqual(
            checked_page(
                {"statusCode": 0, "itemList": [], "hasMore": False}, "post", "0"
            )[0],
            [],
        )
        for payload in (
            {},
            {"statusCode": 10222, "itemList": [], "hasMore": False},
            {"statusCode": 0, "hasMore": False},
            {"statusCode": 0, "itemList": [], "hasMore": True},
        ):
            with self.assertRaises(ProviderError):
                checked_page(payload, "post", "0")

    def test_explicit_zero_story_without_itemlist_is_empty_but_incomplete_is_error(
        self,
    ):
        payload = {
            "statusCode": 0,
            "status_code": 0,
            "TotalCount": "0",
            "HasMoreAfter": False,
            "HasMoreBefore": False,
        }
        self.assertEqual(checked_page(payload, "story", "0"), ([], "0", False))
        for field, value in [
            ("TotalCount", "1"),
            ("HasMoreBefore", True),
            ("status_code", 1),
        ]:
            invalid = {**payload, field: value}
            with self.assertRaises(ProviderError):
                checked_page(invalid, "story", "0")
        for key in ("statusCode", "status_code"):
            invalid = {k: v for k, v in payload.items() if k != key}
            with self.assertRaises(ProviderError):
                checked_page(invalid, "story", "0")

    def test_photo_order_and_reject_unknown_media(self):
        item = {
            "id": "1",
            "author": {"id": "10", "uniqueId": "alice"},
            "createTime": 1,
            "desc": "test",
            "imagePost": {
                "images": [
                    {"imageURL": {"urlList": ["https://p.tiktokcdn.com/1.jpg"]}},
                    {"imageURL": {"urlList": ["https://p.tiktokcdn.com/2.jpg"]}},
                ]
            },
        }
        row = normalize(item, None)
        self.assertTrue(row["assets"][0]["url"].endswith("1.jpg"))
        self.assertEqual(len(row["assets"]), 2)
        with self.assertRaises(ProviderError):
            media_url("https://tiktokcdn.com.evil.test/x")
        with self.assertRaises(ProviderError):
            media_url("http://p.tiktokcdn.com/x")


if __name__ == "__main__":
    unittest.main()
