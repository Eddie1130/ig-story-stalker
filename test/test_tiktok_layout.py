import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tiktok"))
from catalog_layout import (
    LayoutError,
    _migrate_account_layout as migrate_media_layout,
    migrate_media_layout as flatten_media_layout,
)


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


class FlatMediaLayoutTests(unittest.TestCase):
    def setUp(self):
        MediaLayoutTests.setUp(self)
        MediaLayoutTests.legacy(self)
        migrate_media_layout(self.root, self.db, self.state)

    def test_flatten_preserves_all_aliases_and_cross_account_inodes(self):
        source = self.root / "tiktok/alice/media/1/01.mp4"
        alias = self.root / "tiktok/alice/posts/1/01.mp4"
        alias.parent.mkdir(parents=True)
        os.link(source, alias)
        self.assertTrue(flatten_media_layout(self.root, self.db, self.state))
        alice = self.root / "tiktok/alice/media/1_01.mp4"
        bob = self.root / "tiktok/bob/media/1_01.mp4"
        self.assertTrue(alice.samefile(bob))
        self.assertTrue(alice.samefile(alias))
        self.assertFalse(source.parent.exists())
        self.assertFalse(flatten_media_layout(self.root, self.db, self.state))
        self.assertEqual(
            json.loads((self.state / "media-layout.json").read_text())["version"], 3
        )

    def test_conflict_preflights_all_accounts_without_removing_sources(self):
        dest = self.root / "tiktok/bob/media/1_01.mp4"
        dest.write_bytes(b"different archive")
        with self.assertRaisesRegex(LayoutError, "CONFLICT"):
            flatten_media_layout(self.root, self.db, self.state)
        self.assertTrue((self.root / "tiktok/alice/media/1/01.mp4").exists())
        self.assertFalse((self.root / "tiktok/alice/media/1_01.mp4").exists())
        self.assertEqual(dest.read_bytes(), b"different archive")

    def test_interruption_after_first_unlink_resumes(self):
        real = Path.unlink

        def interrupted(file, *args, **kwargs):
            if "bob" in file.parts:
                raise OSError("interrupted")
            return real(file, *args, **kwargs)

        with patch("catalog_layout.Path.unlink", new=interrupted):
            with self.assertRaises(OSError):
                flatten_media_layout(self.root, self.db, self.state)
        flatten_media_layout(self.root, self.db, self.state)
        self.assertTrue(
            (self.root / "tiktok/alice/media/1_01.mp4").samefile(
                self.root / "tiktok/bob/media/1_01.mp4"
            )
        )
        self.assertFalse((self.root / "tiktok/alice/media/1").exists())

    def test_symlink_destination_is_rejected_without_touching_source(self):
        external = Path(self.temp.name) / "external"
        external.write_bytes(b"external")
        (self.root / "tiktok/bob/media/1_01.mp4").symlink_to(external)
        with self.assertRaisesRegex(LayoutError, "SYMLINK"):
            flatten_media_layout(self.root, self.db, self.state)
        self.assertTrue((self.root / "tiktok/alice/media/1/01.mp4").exists())
        self.assertEqual(external.read_bytes(), b"external")

    def test_finder_metadata_and_partial_download_are_preserved(self):
        nested = self.root / "tiktok/alice/media/1"
        (nested / "02.part").write_bytes(b"partial")
        (nested / ".DS_Store").write_bytes(b"finder")
        flatten_media_layout(self.root, self.db, self.state)
        self.assertEqual(
            (self.root / "tiktok/alice/media/1_02.part").read_bytes(), b"partial"
        )
        self.assertEqual(
            (
                self.root / "tiktok/.legacy-media-metadata/alice/1/.DS_Store"
            ).read_bytes(),
            b"finder",
        )

    def test_fresh_global_cache_upgrades_directly_to_flat(self):
        # The v2 helper tests remain separately covered for existing installations.
        new_root = Path(self.temp.name) / "fresh"
        new_state = Path(self.temp.name) / "fresh-state"
        cache = new_root / "tiktok/media/1/01.jpg"
        cache.parent.mkdir(parents=True)
        cache.write_bytes(b"photo")
        flatten_media_layout(new_root, self.db, new_state)
        self.assertEqual(
            (new_root / "tiktok/alice/media/1_01.jpg").read_bytes(), b"photo"
        )
        self.assertFalse((new_root / "tiktok/media").exists())

    def test_profile_hash_timestamp_id_resumes_after_partial_migration(self):
        iid = "a" * 64 + "_1700000000000"
        self.db.execute(
            "INSERT INTO items VALUES(?)",
            (json.dumps({"folder": "alice", "item": {"id": iid}}),),
        )
        directory = self.root / "tiktok/alice/media" / iid
        directory.mkdir()
        for name in ("01.jpg", "02.jpg"):
            (directory / name).write_bytes(name.encode())
        real = Path.unlink

        def interrupted(file, *args, **kwargs):
            if file.parent == directory and file.name == "02.jpg":
                raise OSError("interrupted")
            return real(file, *args, **kwargs)

        with patch("catalog_layout.Path.unlink", new=interrupted):
            with self.assertRaises(OSError):
                flatten_media_layout(self.root, self.db, self.state)
        flatten_media_layout(self.root, self.db, self.state)
        for name in ("01.jpg", "02.jpg"):
            self.assertEqual(
                (directory.parent / f"{iid}_{name}").read_bytes(), name.encode()
            )
        self.assertFalse(directory.exists())


if __name__ == "__main__":
    unittest.main()
