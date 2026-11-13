"""Offline history tests; no X credentials or installed twscrape required."""
import asyncio
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import types
import unittest
from datetime import date, datetime, timedelta, timezone
from unittest.mock import AsyncMock, patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
if importlib.util.find_spec("twscrape") is None:
    sys.modules["twscrape"] = types.SimpleNamespace(API=object)
import x_archive as archive


class HistoryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def test_start_is_optional(self):
        args = archive.make_parser().parse_args(["alice"])
        self.assertIsNone(args.start)

    def test_auto_start_uses_utc_creation_day(self):
        created = datetime(2012, 5, 2, 1, tzinfo=timezone(timedelta(hours=9)))
        self.assertEqual(archive.resolve_start(None, types.SimpleNamespace(created=created), date(2026, 11, 13)), date(2012, 5, 1))

    def test_invalid_creation_date_requires_explicit_start(self):
        for created in [None, datetime(1970, 1, 1, tzinfo=timezone.utc), datetime(2099, 1, 1, tzinfo=timezone.utc), "not a date"]:
            with self.subTest(created=created):
                with self.assertRaisesRegex(ValueError, "X_START_DATE_REQUIRED"):
                    archive.resolve_start(None, types.SimpleNamespace(created=created), date(2026, 11, 13))

    def test_explicit_start_does_not_require_profile_creation(self):
        self.assertEqual(archive.resolve_start(date(2020, 1, 1), object(), date(2026, 11, 13)), date(2020, 1, 1))
        with self.assertRaisesRegex(ValueError, "X_INVALID_DATE_RANGE"):
            archive.resolve_start(date(2027, 1, 1), object(), date(2026, 11, 13))

    def test_range_resolves_and_progress_reports_completion(self):
        args = archive.make_parser().parse_args(["alice", "--out", str(self.root), "--end", "2012-01-03", "--mode", "fast", "--progress", str(self.root / "progress.json"), "--jitter-min", "0", "--jitter-max", "0"])
        async def empty_search():
            if False:
                yield
        api = types.SimpleNamespace(user_by_login=AsyncMock(return_value=types.SimpleNamespace(id=123, username="alice", created=datetime(2012, 1, 1, tzinfo=timezone.utc))), search=lambda *_args, **_kwargs: empty_search())
        with patch.object(archive, "API", return_value=api) as api_factory, patch.object(archive, "run_timeline_passes", new=AsyncMock(return_value=[])):
            with contextlib.redirect_stdout(io.StringIO()):
                summary = asyncio.run(archive.async_main(args))
        self.assertEqual(args.start, date(2012, 1, 1))
        self.assertEqual(summary["status"], "complete")
        self.assertTrue((self.root / "alice_posts.jsonl").exists())
        progress = json.loads((self.root / "progress.json").read_text())
        self.assertEqual(progress["status"], "complete")
        self.assertEqual(progress["start"], "2012-01-01")
        self.assertEqual((progress["completedWindows"], progress["totalWindows"]), (1, 1))
        self.assertEqual(progress["stage"], "export")
        self.assertTrue(api_factory.call_args.kwargs["raise_when_no_account"])
        self.assertLessEqual(api_factory.call_args.kwargs["wait_timeout"], 60)

    def test_timeline_failure_is_partial_not_complete(self):
        args = archive.make_parser().parse_args(["alice", "--out", str(self.root), "--start", "2012-01-01", "--end", "2012-01-03", "--mode", "fast"])
        api = types.SimpleNamespace(user_by_login=AsyncMock(return_value=types.SimpleNamespace(id=123, username="alice")))
        with patch.object(archive, "API", return_value=api), patch.object(archive, "run_timeline_passes", new=AsyncMock(return_value=["user_media"])), patch.object(archive, "run_search_pass", new=AsyncMock()):
            with contextlib.redirect_stdout(io.StringIO()):
                summary = asyncio.run(archive.async_main(args))
        self.assertEqual(summary["status"], "partial")
        self.assertEqual(summary["timeline_failures"], ["user_media"])

    def test_failed_or_partial_search_windows_are_partial(self):
        for state in ["failed", "partial"]:
            with self.subTest(state=state):
                db = archive.ArchiveDB(self.root / f"{state}.sqlite")
                db.mark_window("key", "search_main", date(2020, 1, 1), date(2020, 1, 2), "query", state)
                summary = db.export(self.root, "alice")[3]
                self.assertEqual(summary["status"], "partial")
                db.close()

    def test_new_job_status_excludes_failed_windows_from_unrelated_old_ranges(self):
        db = archive.ArchiveDB(self.root / "scope.sqlite")
        db.mark_window("old", "search_main", date(2015, 1, 1), date(2015, 1, 2), "old", "failed")
        db.begin_job()
        db.track_window("current")
        db.mark_window("current", "search_main", date(2026, 1, 1), date(2026, 1, 2), "new", "done")
        summary = db.export(self.root, "alice")[3]
        self.assertEqual(summary["status"], "complete")
        self.assertEqual(summary["window_status_counts"], {"done": 1})
        db.close()

    def test_no_account_aborts_without_splitting_entire_history(self):
        class NoAccountError(Exception):
            pass
        db = archive.ArchiveDB(self.root / "archive.sqlite")
        with patch.object(archive, "search_window_once", new=AsyncMock(side_effect=NoAccountError("secret session"))) as search:
            with self.assertRaises(NoAccountError):
                asyncio.run(asyncio.wait_for(archive.process_search_window(object(), db, "alice", 123, "search_main", date(2006, 1, 1), date(2026, 1, 1), "", 100, 3, 0, 0), timeout=0.05))
            self.assertEqual(search.call_count, 1)
        db.close()

    def test_invalid_username_does_not_create_archive(self):
        args = archive.make_parser().parse_args(["../escape", "--start", "2020-01-01", "--out", str(self.root / "new")])
        with self.assertRaisesRegex(ValueError, "X_INVALID_USERNAME"):
            asyncio.run(archive.async_main(args))
        self.assertFalse((self.root / "new").exists())

    def test_progress_is_sanitized(self):
        progress = self.root / "p.json"
        archive.write_progress(progress, {"status": "failed", "reason": "X_HISTORY_FAILED", "cookies": "secret", "password": "secret", "at": 1})
        payload = json.loads(progress.read_text())
        self.assertNotIn("cookies", payload)
        self.assertNotIn("password", payload)
        self.assertEqual(payload["reason"], "X_HISTORY_FAILED")

class WorkerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def test_status_does_not_create_database(self):
        import x_history_worker as worker
        db = self.root / "missing.db"
        self.assertEqual(worker.pool_status(db)["status"], "missing")
        self.assertFalse(db.exists())

    def test_status_never_returns_credentials_or_usernames(self):
        import x_history_worker as worker
        db = self.root / "pool.db"
        with sqlite3.connect(db) as conn:
            conn.execute("CREATE TABLE accounts(username TEXT, active INTEGER, locks TEXT, cookies TEXT)")
            conn.executemany("INSERT INTO accounts VALUES(?,?,?,?)", [("secret-user", 1, '{}', 'secret-cookie'), ("other", 1, '{"SearchTimeline":"2099-01-01 00:00:00"}', 'secret-cookie'), ("inactive", 0, '{}', 'secret-cookie')])
        status = worker.pool_status(db)
        self.assertEqual({k: status[k] for k in ["total", "active", "locked", "available", "inactive"]}, {"total": 3, "active": 2, "locked": 1, "available": 1, "inactive": 1})
        self.assertNotIn("secret", json.dumps(status))

    def test_all_rate_limited_accounts_report_the_earliest_fully_usable_time(self):
        import x_history_worker as worker
        db = self.root / "locked.db"
        now = datetime(2026, 11, 12, 18, 6, tzinfo=timezone.utc)
        with sqlite3.connect(db) as conn:
            conn.execute("CREATE TABLE accounts(active INTEGER, locks TEXT)")
            conn.executemany("INSERT INTO accounts VALUES(?,?)", [
                (1, json.dumps({"UserTweetsAndReplies": "2026-11-12 18:16:16", "SearchTimeline": "2026-11-12 18:18:00"})),
                (1, json.dumps({"SearchTimeline": "2026-11-12 18:18:28"})),
                (1, json.dumps({"SearchTimeline": "2026-11-12 18:18:54"})),
            ])
        status = worker.pool_status(db, now=now)
        self.assertEqual(status["available"], 0)
        self.assertEqual(status["nextAvailableAt"], int(datetime(2026,11,12,18,18,tzinfo=timezone.utc).timestamp()*1000))
        ready = worker.pool_status(db, now=datetime(2026,11,12,18,19,tzinfo=timezone.utc))
        self.assertEqual(ready["available"], 3)
        self.assertIsNone(ready["nextAvailableAt"])

    def test_corrupt_pool_is_explicit_error(self):
        import x_history_worker as worker
        db = self.root / "pool.db"
        db.write_text("not a SQLite file")
        with self.assertRaisesRegex(ValueError, "X_ACCOUNTS_DB_INVALID"):
            worker.pool_status(db)

    def test_render_only_does_not_download_and_uses_common_manifest(self):
        import extract_x_archive as extract
        media = self.root / "media" / "shared.jpg"
        media.parent.mkdir()
        media.write_bytes(b"image")
        post = {"id": "1", "username": "alice", "text": "hello", "media": {"images": ["https://pbs.twimg.com/a.jpg"]}}
        (self.root / "alice_posts.jsonl").write_text(json.dumps(post) + "\n")
        (self.root / "media_manifest.json").write_text(json.dumps({"media": {"https://pbs.twimg.com/a.jpg": {"path": "media/shared.jpg"}}}))
        with patch.object(sys, "argv", ["extract_x_archive.py", str(self.root), "--render-only"]), patch.object(extract, "download", side_effect=AssertionError("must not download")):
            extract.main()
        markdown = (self.root / "extract.md").read_text()
        self.assertIn("media/shared.jpg", markdown)
        self.assertIn("hello", markdown)

class WorkerFlowTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def args(self):
        return types.SimpleNamespace(username="alice", accounts_db=str(self.root / "accounts.db"), out=str(self.root), progress=str(self.root / "progress.json"), start=None, end="2026-11-13")

    def test_worker_success_and_partial_exit_codes(self):
        import x_history_worker as worker
        for status, code in [("complete", 0), ("partial", 2)]:
            with patch.object(worker, "pool_status", return_value={"active": 1}), patch.object(archive, "async_main", new=AsyncMock(return_value={"status": status, "posts": 12, "window_status_counts": {"done": 1}})), contextlib.redirect_stdout(io.StringIO()) as output:
                self.assertEqual(worker.run_history(self.args()), code)
            self.assertEqual(json.loads(output.getvalue())["status"], status)

    def test_worker_no_pool_writes_safe_failed_progress(self):
        import x_history_worker as worker
        args = self.args()
        with contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(worker.run_history(args), 1)
        self.assertEqual(json.loads(output.getvalue())["reason"], "X_NO_ACCOUNT_AVAILABLE")
        progress = json.loads(Path(args.progress).read_text())
        self.assertEqual(progress["end"], args.end)
        self.assertEqual(progress["status"], "failed")

    def test_worker_missing_creation_date_preserves_progress_and_requests_start(self):
        import x_history_worker as worker
        args = self.args()
        archive.write_progress(args.progress, {"start": None, "end": args.end, "posts": 5})
        with patch.object(worker, "pool_status", return_value={"active": 1}), patch.object(archive, "async_main", new=AsyncMock(side_effect=ValueError("X_START_DATE_REQUIRED"))), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(worker.run_history(args), 1)
        result = json.loads(Path(args.progress).read_text())
        self.assertEqual(result["status"], "needs_start")
        self.assertEqual(result["posts"], 5)
        self.assertIsNone(result["start"])

    def test_generic_exception_does_not_leak_credentials(self):
        import x_history_worker as worker
        args = self.args()
        with patch.object(worker, "pool_status", return_value={"active": 1}), patch.object(archive, "async_main", new=AsyncMock(side_effect=RuntimeError("auth_token=secret-password"))), contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(worker.run_history(args), 1)
        self.assertNotIn("secret", output.getvalue())
        self.assertNotIn("secret", Path(args.progress).read_text())

    def test_main_status_cli_success_and_failure(self):
        import x_history_worker as worker
        for error, expected in [(None, 0), (ValueError("bad"), 1)]:
            with patch.object(sys, "argv", ["x_history_worker.py", "status", "--accounts-db", "test.db"]), patch.object(worker, "pool_status", return_value={"status": "missing"}, side_effect=error), contextlib.redirect_stdout(io.StringIO()) as output:
                self.assertEqual(worker.main(), expected)
            self.assertEqual(json.loads(output.getvalue())["status"], "failed" if error else "missing")

    def test_start_failure_progress_does_not_claim_complete_export(self):
        args = archive.make_parser().parse_args(["alice", "--out", str(self.root), "--end", "2026-11-13", "--progress", str(self.root / "progress.json")])
        api = types.SimpleNamespace(user_by_login=AsyncMock(return_value=types.SimpleNamespace(id=123, username="alice", created=None)))
        with patch.object(archive, "API", return_value=api), contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaisesRegex(ValueError, "X_START_DATE_REQUIRED"):
                asyncio.run(archive.async_main(args))
        self.assertEqual(json.loads((self.root / "progress.json").read_text())["status"], "needs_start")
        self.assertEqual(json.loads((self.root / "alice_summary.json").read_text())["status"], "failed")

    def test_progress_refuses_symlinks(self):
        dest = self.root / "dest"
        dest.write_text("keep")
        progress = self.root / "progress"
        progress.symlink_to(dest)
        with self.assertRaisesRegex(ValueError, "X_UNSAFE_PATH"):
            archive.write_progress(progress, {"status": "working"})
        self.assertEqual(dest.read_text(), "keep")

    def test_export_only_does_not_require_twscrape_or_start(self):
        args = archive.make_parser().parse_args(["alice", "--export-only", "--out", str(self.root)])
        with patch.object(archive, "API", None), contextlib.redirect_stdout(io.StringIO()):
            result = asyncio.run(archive.async_main(args))
        self.assertEqual(result["posts"], 0)

    def test_real_timeline_failures_are_reported_and_no_account_rethrown(self):
        class NoAccountError(Exception):
            pass
        async def broken(error):
            raise error
            yield
        db = archive.ArchiveDB(self.root / "archive.db")
        api = types.SimpleNamespace(user_tweets_and_replies=lambda *a, **kw: broken(RuntimeError("secret")), user_media=lambda *a, **kw: broken(RuntimeError("secret")))
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()) as output:
            failures = asyncio.run(archive.run_timeline_passes(api, db, 1, 20))
        self.assertEqual(failures, ["user_tweets_and_replies", "user_media"])
        self.assertNotIn("secret", output.getvalue())
        api.user_tweets_and_replies = lambda *a, **kw: broken(NoAccountError("secret"))
        with contextlib.redirect_stdout(io.StringIO()), self.assertRaises(NoAccountError):
            asyncio.run(archive.run_timeline_passes(api, db, 1, 20))
        db.close()


class SearchProgressTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.db = archive.ArchiveDB(self.root / "archive.sqlite")

    def tearDown(self):
        self.db.close()
        self.temp.cleanup()

    def mark(self, pass_name, start, end, status):
        self.db.mark_window(archive.window_key(pass_name, start, end), pass_name, start, end, "query", status)

    def test_deep_plan_for_actual_account_has_1196_fixed_root_windows(self):
        snapshot = archive.search_progress(self.db, date(2017, 9, 19), date(2026, 11, 13), "deep", 7, 28)
        self.assertEqual(snapshot["totalWindows"], 1196)
        self.assertEqual(snapshot["remainingWindows"], 1196)
        self.assertEqual(snapshot["completedWindows"], 0)
        self.assertEqual({p["name"]: p["total"] for p in snapshot["passes"]}, {
            "search_main": 478, "search_replies": 120, "search_media": 120, "search_verify": 478,
        })

    def test_modes_plan_only_the_passes_they_execute(self):
        for mode, totals in [("fast", [2]), ("balanced", [2, 1, 1]), ("deep", [2, 1, 1, 3])]:
            with self.subTest(mode=mode):
                snapshot = archive.search_progress(self.db, date(2020, 1, 1), date(2020, 1, 15), mode, 7, 28)
                self.assertEqual([p["total"] for p in snapshot["passes"]], totals)
                self.assertEqual(snapshot["totalWindows"], sum(totals))

    def test_empty_and_invalid_plan_never_divides_or_loops(self):
        snapshot = archive.search_progress(self.db, date(2020, 1, 1), date(2020, 1, 1), "deep", 7, 28)
        self.assertEqual(snapshot["totalWindows"], 0)
        self.assertEqual(snapshot["remainingWindows"], 0)
        for mode, days, special in [("unknown", 7, 28), ("deep", 0, 28), ("deep", 7, 0)]:
            with self.subTest(mode=mode, days=days, special=special):
                with self.assertRaisesRegex(ValueError, "X_INVALID_SEARCH_PLAN"):
                    archive.search_progress(self.db, date(2020, 1, 1), date(2020, 1, 15), mode, days, special)

    def test_nested_split_children_complete_one_root_without_inflating_denominator(self):
        self.mark("search_main", date(2020, 1, 1), date(2020, 1, 8), "split")
        self.mark("search_main", date(2020, 1, 1), date(2020, 1, 4), "done")
        self.mark("search_main", date(2020, 1, 4), date(2020, 1, 8), "split")
        self.mark("search_main", date(2020, 1, 4), date(2020, 1, 6), "done")
        self.mark("search_main", date(2020, 1, 6), date(2020, 1, 8), "done")
        snapshot = archive.search_progress(self.db, date(2020, 1, 1), date(2020, 1, 8), "fast", 7, 28)
        self.assertEqual(snapshot["totalWindows"], 1)
        self.assertEqual(snapshot["completedWindows"], 1)
        self.assertEqual(snapshot["remainingWindows"], 0)
        self.assertEqual(snapshot["passes"], [{"name": "search_main", "total": 1, "completed": 1, "partial": 0, "failed": 0}])

    def test_failed_partial_and_missing_split_children_are_not_complete(self):
        self.mark("search_main", date(2020, 1, 1), date(2020, 1, 8), "split")
        self.mark("search_main", date(2020, 1, 1), date(2020, 1, 4), "done")
        for child_state, failed, partial in [(None, 0, 0), ("failed", 1, 0), ("partial", 0, 1), ("done", 0, 0)]:
            if child_state:
                self.mark("search_main", date(2020, 1, 4), date(2020, 1, 8), child_state)
            snapshot = archive.search_progress(self.db, date(2020, 1, 1), date(2020, 1, 8), "fast", 7, 28)
            self.assertEqual(snapshot["completedWindows"], int(child_state == "done"))
            self.assertEqual(snapshot["remainingWindows"], int(child_state != "done"))
            self.assertEqual(snapshot["failedWindows"], failed)
            self.assertEqual(snapshot["partialWindows"], partial)

    def test_unrelated_modes_and_ranges_do_not_change_progress(self):
        self.mark("search_main", date(2015, 1, 1), date(2015, 1, 8), "done")
        self.mark("search_media", date(2020, 1, 1), date(2020, 1, 8), "failed")
        self.mark("search_main", date(2020, 1, 1), date(2020, 1, 8), "done")
        snapshot = archive.search_progress(self.db, date(2020, 1, 1), date(2020, 1, 15), "fast", 7, 28)
        self.assertEqual(snapshot["totalWindows"], 2)
        self.assertEqual(snapshot["completedWindows"], 1)
        self.assertEqual(snapshot["failedWindows"], 0)

    def test_before_upstream_failure_current_window_and_stage_are_published(self):
        class NoAccountError(Exception):
            pass
        snapshots = []
        self.db.progress = lambda: snapshots.append(dict(self.db.progress_context))
        with patch.object(archive, "search_window_once", new=AsyncMock(side_effect=NoAccountError("secret"))):
            with self.assertRaises(NoAccountError):
                asyncio.run(archive.process_search_window(object(), self.db, "alice", 123, "search_replies", date(2020, 1, 1), date(2020, 1, 8), "filter:replies", 100, 1, 0, 0))
        self.assertTrue(snapshots)
        self.assertEqual(snapshots[-1], {"stage": "search", "lastWorkStage": "search", "currentPass": "search_replies", "windowStart": "2020-01-01", "windowEnd": "2020-01-08"})

    def test_resumed_progress_is_visible_before_timeline_and_survives_stop(self):
        # The command opens its conventional DB name and restores checkpoints.
        self.db.close()
        self.db = archive.ArchiveDB(self.root / "alice_archive.sqlite")
        self.mark("search_main", date(2020, 1, 1), date(2020, 1, 8), "done")
        args = archive.make_parser().parse_args(["alice", "--start", "2020-01-01", "--end", "2020-01-15", "--out", str(self.root), "--progress", str(self.root / "progress.json"), "--mode", "fast"])
        api = types.SimpleNamespace(user_by_login=AsyncMock(return_value=types.SimpleNamespace(id=123, username="alice")))
        captured = []
        async def stop_in_timeline(*_):
            captured.append(json.loads((self.root / "progress.json").read_text()))
            raise RuntimeError("stop here")
        with patch.object(archive, "API", return_value=api), patch.object(archive, "run_timeline_passes", new=stop_in_timeline), contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaises(RuntimeError):
                asyncio.run(archive.async_main(args))
        before = captured[0]
        self.assertEqual((before["completedWindows"], before["totalWindows"], before["remainingWindows"]), (1, 2, 1))
        self.assertEqual(before["stage"], "timeline_posts")
        stopped = json.loads((self.root / "progress.json").read_text())
        self.assertEqual(stopped["stage"], "stopped")
        self.assertEqual(stopped["lastWorkStage"], "timeline_posts")
        self.assertEqual(stopped["completedWindows"], 1)

    def test_timeline_periodic_updates_are_bounded_instead_of_per_item(self):
        async def posts():
            for index in range(250):
                yield types.SimpleNamespace(id=index+1, user=types.SimpleNamespace(id=123, username="alice"), rawContent="text")
        snapshots = []
        self.db.progress = lambda: snapshots.append(self.db.count())
        with patch.object(archive, "monotonic", side_effect=range(1000)):
            asyncio.run(archive.consume_timeline(posts(), self.db, 123, "user_tweets_and_replies"))
        self.assertIn(100, snapshots)
        self.assertIn(200, snapshots)
        self.assertLess(len(snapshots), 10)

    def test_extended_progress_fields_are_written_without_allowing_secrets(self):
        payload = {"totalWindows": 2, "remainingWindows": 1, "passes": [{"name": "search_main", "total": 2, "completed": 1, "partial": 0, "failed": 0}], "currentPass": "search_main", "windowStart": "2020-01-08", "windowEnd": "2020-01-15", "lastWorkStage": "search", "cookies": "secret"}
        dest = self.root / "progress.json"
        archive.write_progress(dest, payload)
        saved = json.loads(dest.read_text())
        for key, value in payload.items():
            if key != "cookies":
                self.assertEqual(saved[key], value)
        self.assertNotIn("cookies", saved)


    def test_idle_heartbeat_runs_during_upstream_wait_and_stops_after_exit(self):
        snapshots = []
        self.db.progress = lambda: snapshots.append(self.db.count())
        async def scenario():
            async with archive.activity_progress(self.db, interval=0.005, min_interval=0.001):
                await asyncio.sleep(0.02)
            emitted = len(snapshots)
            await asyncio.sleep(0.01)
            self.assertGreaterEqual(emitted, 1)
            self.assertEqual(len(snapshots), emitted)
        asyncio.run(scenario())

    def test_real_deep_flow_reaches_100_percent_and_reports_each_phase(self):
        args = archive.make_parser().parse_args(["alice", "--start", "2020-01-01", "--end", "2020-01-15", "--out", str(self.root), "--progress", str(self.root / "progress.json"), "--mode", "deep", "--jitter-min", "0", "--jitter-max", "0"])
        async def empty():
            if False:
                yield
        api = types.SimpleNamespace(user_by_login=AsyncMock(return_value=types.SimpleNamespace(id=123, username="alice")), user_tweets_and_replies=lambda *_a, **_kw: empty(), user_media=lambda *_a, **_kw: empty(), search=lambda *_a, **_kw: empty())
        with patch.object(archive, "API", return_value=api), patch.object(archive, "write_progress", wraps=archive.write_progress) as writer, contextlib.redirect_stdout(io.StringIO()):
            summary = asyncio.run(archive.async_main(args))
        self.assertEqual(summary["status"], "complete")
        snapshots = [call.args[1] for call in writer.call_args_list]
        stages = {snapshot["stage"] for snapshot in snapshots}
        self.assertEqual(stages, {"resolve", "timeline_posts", "timeline_media", "search", "export"})
        current_passes = {snapshot["currentPass"] for snapshot in snapshots if snapshot["stage"] == "search"}
        self.assertEqual(current_passes, {"search_main", "search_replies", "search_media", "search_verify"})
        final = json.loads((self.root / "progress.json").read_text())
        self.assertEqual((final["completedWindows"], final["totalWindows"], final["remainingWindows"]), (7, 7, 0))
        self.assertTrue(all(p["completed"] == p["total"] for p in final["passes"]))

    def test_incomplete_plan_and_malformed_one_day_split_remain_partial(self):
        self.db.search_plan = (date(2020, 1, 1), date(2020, 1, 2), "fast", 7, 28)
        self.mark("search_main", date(2020, 1, 1), date(2020, 1, 2), "split")
        snapshot = archive.search_progress(self.db, *self.db.search_plan)
        self.assertEqual(snapshot["completedWindows"], 0)
        self.assertEqual(snapshot["partialWindows"], 1)
        self.assertEqual(self.db.export(self.root, "alice")[3]["status"], "partial")


    def test_profile_lookup_failure_preserves_cached_983_of_1196_progress(self):
        class NoAccountError(Exception):
            pass
        self.db.close()
        self.db = archive.ArchiveDB(self.root / "alice_archive.sqlite")
        start, end = date(2017, 9, 19), date(2026, 11, 13)
        self.db.set_meta("requested_start", start.isoformat())
        checkpoints = []
        for name, days, offset in [("search_main", 7, 0), ("search_replies", 28, 0), ("search_media", 28, 0), ("search_verify", 7, 3)]:
            for left, right in archive.iter_windows(start, end, days, offset):
                checkpoints.append((archive.window_key(name, left, right), name, left.isoformat(), right.isoformat(), "query", "done", "2026-11-12T00:00:00Z"))
        self.db.conn.executemany("INSERT INTO windows(window_key, pass_name, start_date, end_date, query, status, updated_at) VALUES(?,?,?,?,?,?,?)", checkpoints[:983])
        self.db.conn.commit()
        args = archive.make_parser().parse_args(["alice", "--end", end.isoformat(), "--out", str(self.root), "--progress", str(self.root / "progress.json")])
        api = types.SimpleNamespace(user_by_login=AsyncMock(side_effect=NoAccountError("secret")))
        with patch.object(archive, "API", return_value=api), patch.object(archive, "write_progress", wraps=archive.write_progress) as writer, contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaises(NoAccountError):
                asyncio.run(archive.async_main(args))
        snapshots = [call.args[1] for call in writer.call_args_list]
        for snapshot in snapshots:
            self.assertEqual((snapshot["completedWindows"], snapshot["totalWindows"], snapshot["remainingWindows"]), (983, 1196, 213))
            self.assertEqual(snapshot["start"], "2017-09-19")
        self.assertEqual(snapshots[0]["stage"], "resolve")
        self.assertEqual(snapshots[-1]["stage"], "stopped")
        self.assertEqual(snapshots[-1]["lastWorkStage"], "resolve")
        self.assertIsNone(args.start, "cached progress start must not become the actual query start")
        api.user_by_login.assert_awaited_once_with("alice")

    def test_explicit_start_takes_precedence_over_cached_progress_start(self):
        class NoAccountError(Exception):
            pass
        self.db.close()
        self.db = archive.ArchiveDB(self.root / "alice_archive.sqlite")
        self.db.set_meta("requested_start", "2015-01-01")
        self.mark("search_main", date(2020, 1, 1), date(2020, 1, 8), "done")
        args = archive.make_parser().parse_args(["alice", "--start", "2020-01-01", "--end", "2020-01-15", "--mode", "fast", "--out", str(self.root), "--progress", str(self.root / "progress.json")])
        api = types.SimpleNamespace(user_by_login=AsyncMock(side_effect=NoAccountError("unavailable")))
        with patch.object(archive, "API", return_value=api), contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaises(NoAccountError):
                asyncio.run(archive.async_main(args))
        snapshot = json.loads((self.root / "progress.json").read_text())
        self.assertEqual((snapshot["completedWindows"], snapshot["totalWindows"]), (1, 2))
        self.assertEqual(snapshot["start"], "2020-01-01")

    def test_cached_progress_start_does_not_override_resolved_creation_date(self):
        self.db.close()
        self.db = archive.ArchiveDB(self.root / "alice_archive.sqlite")
        self.db.set_meta("requested_start", "2020-01-01")
        self.mark("search_main", date(2020, 1, 1), date(2020, 1, 8), "done")
        queries = []
        async def empty():
            if False:
                yield
        def search(query, **_kwargs):
            queries.append(query)
            return empty()
        args = archive.make_parser().parse_args(["alice", "--end", "2021-01-15", "--mode", "fast", "--out", str(self.root), "--progress", str(self.root / "progress.json"), "--jitter-min", "0", "--jitter-max", "0"])
        api = types.SimpleNamespace(user_by_login=AsyncMock(return_value=types.SimpleNamespace(id=123, username="alice", created=datetime(2021, 1, 1, tzinfo=timezone.utc))), user_tweets_and_replies=lambda *_a, **_kw: empty(), user_media=lambda *_a, **_kw: empty(), search=search)
        with patch.object(archive, "API", return_value=api), contextlib.redirect_stdout(io.StringIO()):
            summary = asyncio.run(archive.async_main(args))
        self.assertEqual(summary["status"], "complete")
        self.assertEqual(args.start, date(2021, 1, 1))
        self.assertEqual(len(queries), 2)
        self.assertTrue(all("since:2021-" in query for query in queries))
        snapshot = json.loads((self.root / "progress.json").read_text())
        self.assertEqual((snapshot["completedWindows"], snapshot["totalWindows"]), (2, 2))
        self.assertEqual(snapshot["start"], "2021-01-01")


    def test_invalid_cached_progress_dates_do_not_block_profile_lookup(self):
        class NoAccountError(Exception):
            pass
        self.db.close()
        self.db = archive.ArchiveDB(self.root / "alice_archive.sqlite")
        for cached in ["not-a-date", "2099-01-01"]:
            with self.subTest(cached=cached):
                self.db.set_meta("requested_start", cached)
                args = archive.make_parser().parse_args(["alice", "--end", "2026-11-13", "--out", str(self.root), "--progress", str(self.root / "progress.json")])
                api = types.SimpleNamespace(user_by_login=AsyncMock(side_effect=NoAccountError("unavailable")))
                with patch.object(archive, "API", return_value=api), contextlib.redirect_stdout(io.StringIO()):
                    with self.assertRaises(NoAccountError):
                        asyncio.run(archive.async_main(args))
                api.user_by_login.assert_awaited_once_with("alice")
                snapshot = json.loads((self.root / "progress.json").read_text())
                self.assertEqual(snapshot["reason"], "X_NO_ACCOUNT_AVAILABLE")
                self.assertEqual(snapshot["totalWindows"], 0)
                self.assertIsNone(args.start)

    def test_cached_progress_start_cannot_bypass_missing_creation_date(self):
        self.db.close()
        self.db = archive.ArchiveDB(self.root / "alice_archive.sqlite")
        self.db.set_meta("requested_start", "2020-01-01")
        args = archive.make_parser().parse_args(["alice", "--end", "2020-01-15", "--mode", "fast", "--out", str(self.root), "--progress", str(self.root / "progress.json")])
        api = types.SimpleNamespace(user_by_login=AsyncMock(return_value=types.SimpleNamespace(id=123, username="alice", created=None)))
        with patch.object(archive, "API", return_value=api), contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaisesRegex(ValueError, "X_START_DATE_REQUIRED"):
                asyncio.run(archive.async_main(args))
        self.assertIsNone(args.start)
        snapshot = json.loads((self.root / "progress.json").read_text())
        self.assertEqual(snapshot["status"], "needs_start")
        self.assertEqual(snapshot["totalWindows"], 2)


if __name__ == "__main__":
    unittest.main()
