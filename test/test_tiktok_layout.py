import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tiktok"))
from catalog_layout import LayoutError, migrate_media_layout


class MediaLayoutTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve() / "downloads"
        self.state = Path(self.temp.name) / "state"
        self.db = sqlite3.connect(":memory:")
        self.addCleanup(self.db.close)
        self.db.executescript(
            "CREATE TABLE targets(id TEXT,folder TEXT);CREATE TABLE items(data TEXT);"
        )
        for uid, name in [("10", "alice"), ("20", "bob")]:
            self.db.execute("INSERT INTO targets VALUES(?,?)", (uid, name))
            self.db.execute(
                "INSERT INTO items VALUES(?)",
                (json.dumps({"folder": name, "item": {"id": "1"}}),),
            )

    def legacy(self, filename="01.mp4"):
        file = self.root / "tiktok/media/1" / filename
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_bytes(b"original archive bytes")
        return file

    def test_migration_preserves_aliases_and_cross_account_hardlinks(self):
        source = self.legacy()
        alias = self.root / "tiktok/alice/posts/1/01.mp4"
        alias.parent.mkdir(parents=True)
        os.link(source, alias)
        self.assertTrue(migrate_media_layout(self.root, self.db, self.state))
        alice = self.root / "tiktok/alice/media/1/01.mp4"
        bob = self.root / "tiktok/bob/media/1/01.mp4"
        self.assertTrue(os.path.samefile(alice, bob))
        self.assertTrue(os.path.samefile(alice, alias))
        self.assertEqual(alice.read_bytes(), b"original archive bytes")
        self.assertFalse((self.root / "tiktok/media").exists())
        self.assertFalse(migrate_media_layout(self.root, self.db, self.state))

    def test_interrupted_link_creation_resumes_without_overwrite(self):
        source = self.legacy()
        real = os.link
        calls = 0

        def interrupted(src, dst):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise OSError("simulated interruption")
            return real(src, dst)

        with patch("catalog_layout.os.link", side_effect=interrupted):
            with self.assertRaises(OSError):
                migrate_media_layout(self.root, self.db, self.state)
        self.assertTrue(source.exists())
        self.assertFalse((self.state / "media-layout.json").exists())
        migrate_media_layout(self.root, self.db, self.state)
        self.assertTrue(
            os.path.samefile(
                self.root / "tiktok/alice/media/1/01.mp4",
                self.root / "tiktok/bob/media/1/01.mp4",
            )
        )

    def test_interruption_after_one_old_link_removal_is_resumable(self):
        self.legacy("01.mp4")
        self.legacy("02.mp4")
        original = Path.unlink

        def interrupted(file, *args, **kwargs):
            if file.name == "02.mp4":
                raise OSError("simulated interruption")
            return original(file, *args, **kwargs)

        with patch("catalog_layout.Path.unlink", new=interrupted):
            with self.assertRaises(OSError):
                migrate_media_layout(self.root, self.db, self.state)
        self.assertTrue((self.root / "tiktok/alice/media/1/01.mp4").exists())
        migrate_media_layout(self.root, self.db, self.state)
        for name in ("alice", "bob"):
            for file in ("01.mp4", "02.mp4"):
                self.assertEqual(
                    (self.root / "tiktok" / name / "media/1" / file).read_bytes(),
                    b"original archive bytes",
                )

    def test_conflicts_are_detected_before_deleting_any_legacy_link(self):
        source = self.legacy()
        dest = self.root / "tiktok/alice/media/1/01.mp4"
        dest.parent.mkdir(parents=True)
        dest.write_bytes(b"keep different file")
        with self.assertRaisesRegex(LayoutError, "CONFLICT"):
            migrate_media_layout(self.root, self.db, self.state)
        self.assertTrue(source.exists())
        self.assertEqual(dest.read_bytes(), b"keep different file")
        self.assertFalse((self.root / "tiktok/bob/media").exists())

    def test_symlink_and_unknown_ownership_fail_without_deleting_data(self):
        source = self.legacy()
        external = Path(self.temp.name) / "external"
        external.mkdir()
        account = self.root / "tiktok/alice"
        account.mkdir(parents=True)
        (account / "media").symlink_to(external, target_is_directory=True)
        with self.assertRaisesRegex(LayoutError, "SYMLINK"):
            migrate_media_layout(self.root, self.db, self.state)
        self.assertTrue(source.exists())
        self.assertEqual(list(external.iterdir()), [])
        (account / "media").unlink()
        unknown = self.root / "tiktok/media/999"
        unknown.mkdir()
        (unknown / "01.mp4").write_bytes(b"unknown owner")
        with self.assertRaisesRegex(LayoutError, "UNOWNED"):
            migrate_media_layout(self.root, self.db, self.state)
        self.assertTrue(source.exists())
        self.assertTrue((unknown / "01.mp4").exists())

    def test_finder_metadata_is_preserved_outside_media_tree(self):
        self.legacy()
        metadata = self.root / "tiktok/media/.DS_Store"
        metadata.write_bytes(b"finder metadata")
        migrate_media_layout(self.root, self.db, self.state)
        self.assertEqual(
            (self.root / "tiktok/.legacy-media-metadata/.DS_Store").read_bytes(),
            b"finder metadata",
        )
        self.assertFalse((self.root / "tiktok/media").exists())

    def test_legacy_account_named_media_is_rejected_before_mutation(self):
        source = self.legacy()
        self.db.execute("INSERT INTO targets VALUES(?,?)", ("30", "media"))
        self.db.execute(
            "INSERT INTO items VALUES(?)",
            (json.dumps({"folder": "media", "item": {"id": "1"}}),),
        )
        with self.assertRaisesRegex(LayoutError, "RESERVED_ACCOUNT"):
            migrate_media_layout(self.root, self.db, self.state)
        self.assertEqual(source.read_bytes(), b"original archive bytes")
        self.assertFalse((self.root / "tiktok/alice/media").exists())
        self.assertFalse((self.root / "tiktok/media/media").exists())
        self.assertFalse((self.state / "media-layout.json").exists())

    def test_completed_marker_allows_an_account_named_media(self):
        migrate_media_layout(self.root, self.db, self.state)
        account = self.root / "tiktok/media/media/123/01.mp4"
        account.parent.mkdir(parents=True)
        account.write_bytes(b"account data")
        self.assertFalse(migrate_media_layout(self.root, self.db, self.state))
        self.assertEqual(account.read_bytes(), b"account data")


if __name__ == "__main__":
    unittest.main()
