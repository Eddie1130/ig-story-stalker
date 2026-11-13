import importlib.util
import json
from pathlib import Path
import queue
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('tiktok_worker', Path(__file__).resolve().parents[1] / 'tiktok/worker.py')
w = importlib.util.module_from_spec(spec)
spec.loader.exec_module(w)


class TikTokWorkerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.patches = [patch.object(w, 'ROOT', self.root / 'downloads'), patch.object(w, 'STATE', self.root / 'state')]
        for p in self.patches:
            p.start()
            self.addCleanup(p.stop)

    def test_subscription_union_and_revocation(self):
        s = {'allowedIds': ['100', '200'], 'users': {uid: {'tiktokTargets': {'alice': {'generation': uid}}} for uid in ['100', '200']}}
        self.assertEqual(len(w.subscriptions(s)['alice']), 2)
        s['allowedIds'] = ['200']
        self.assertEqual(w.subscriptions(s)['alice'][0]['userId'], '200')
        s['users']['200']['tiktokTargets'] = {}
        self.assertEqual(w.subscriptions(s), {})

    def test_cookie_dictionary_and_browser_array_without_exposing_values(self):
        file = self.root / 'cookies.json'
        for raw in ({'example': 'private'}, [{'name': 'example', 'value': 'private'}]):
            file.write_text(json.dumps(raw))
            with patch.dict(w.os.environ, {'TIKTOK_COOKIE_FILE': str(file)}):
                self.assertEqual(set(w.cookies()), {'example'})
        file.write_text('42')
        with patch.dict(w.os.environ, {'TIKTOK_COOKIE_FILE': str(file)}):
            with self.assertRaises(ValueError):
                w.cookies()

    @unittest.skipUnless(shutil.which('ffmpeg'), 'ffmpeg unavailable')
    def test_real_mp4_remux_and_durable_video_event(self):
        folder = w.ROOT / 'tiktok/alice/live'
        folder.mkdir(parents=True)
        source = folder / '20261114_120000_JST_123_hls.ts'
        subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=128x128:rate=10', '-t', '2', '-c:v', 'mpeg2video', '-f', 'mpegts', str(source)], check=True)
        dest = folder / '20261114_120000_JST_123.mp4'
        job = {'source': str(source), 'dest': str(dest), 'username': 'alice', 'recipients': [{'userId': '100', 'generation': 'test'}], 'at': 1000}
        w.finalize(job)
        self.assertGreater(dest.stat().st_size, 4096)
        self.assertFalse(source.exists())
        event = json.loads(next((w.STATE / 'events').glob('*.json')).read_text())
        self.assertEqual(event['kind'], 'video')
        self.assertEqual(event['files'], [str(dest.relative_to(w.ROOT))])

    @unittest.skipUnless(shutil.which('ffmpeg'), 'ffmpeg unavailable')
    def test_real_split_preserves_full_mp4_and_caps_every_part(self):
        folder = w.ROOT / 'tiktok/alice/live'
        folder.mkdir(parents=True)
        source = folder / 'recording.ts'
        subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=128x128:rate=10', '-t', '10', '-c:v', 'mpeg2video', '-g', '5', '-f', 'mpegts', str(source)], check=True)
        dest = folder / 'recording.mp4'
        job = {'source': str(source), 'dest': str(dest), 'username': 'alice', 'recipients': [], 'at': 1000}
        w.finalize(job, limit=60000)
        self.assertGreater(dest.stat().st_size, 60000)
        event = json.loads(next((w.STATE / 'events').glob('*.json')).read_text())
        self.assertGreater(len(event['files']), 1)
        self.assertTrue(all((w.ROOT / f).stat().st_size <= 60000 for f in event['files']))

    def test_failed_conversion_keeps_original(self):
        source = self.root / 'broken.ts'
        source.write_bytes(b'preserve me')
        job = {'source': str(source), 'dest': str(self.root / 'out.mp4')}
        with patch.object(w, 'run_tool', side_effect=RuntimeError('failed')):
            with self.assertRaises(RuntimeError):
                w.finalize(job)
        self.assertTrue(source.exists())


if __name__ == '__main__':
    unittest.main()
