import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { archiveBase, downloadStory, StoryArchive } from '../src/story-archive.mjs';

const photo = { id: '123', mediaType: 1, takenAt: 1792081800, mediaUrl: 'https://s.cdninstagram.com/photo' };
const jpeg = Buffer.from([255, 216, 255, ...Array(29).fill(0)]);
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ig-archive-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('Story archive writes JST names atomically and reuses complete files', async t => {
  const root = fixture(t);
  const base = archiveBase(photo, '99');
  assert.match(base, /^stories\/\d{8}_\d{6}_JST_123$/);
  let requests = 0;
  const fetchImpl = async (_, options) => {
    requests++;
    assert.equal(options.headers.Cookie, undefined);
    assert.equal(options.redirect, 'manual');
    return new Response(jpeg, { headers: { 'content-length': String(jpeg.length) } });
  };
  const saved = await downloadStory(root, base, photo, { fetchImpl });
  assert.equal(saved.relativePath, base + '.jpg');
  assert.deepEqual(fs.readFileSync(path.join(root, saved.relativePath)), jpeg);
  assert.equal(fs.existsSync(path.join(root, base + '.part')), false);
  assert.equal((await downloadStory(root, base, photo, { fetchImpl })).reused, true);
  assert.equal(requests, 1);
});

test('invalid CDN redirects, truncated files, and HTML leave no completed media', async t => {
  const root = fixture(t);
  for (const [index, fetchImpl, reason] of [
    [0, async () => new Response(null, { status: 302, headers: { location: 'https://example.com/private' } }), /UNEXPECTED_CDN/],
    [1, async () => new Response(jpeg, { headers: { 'content-length': '100' } }), /INCOMPLETE/],
    [2, async () => new Response('<html>invalid content</html>'), /UNEXPECTED_MEDIA/],
  ]) {
    const base = `stories/invalid-${index}`;
    await assert.rejects(downloadStory(root, base, photo, { fetchImpl }), reason);
    assert.equal(fs.existsSync(path.join(root, base + '.part')), false);
    assert.equal(fs.existsSync(path.join(root, base + '.jpg')), false);
  }
});

test('archive retries persist across restart independently of Telegram delivery', async t => {
  const root = fixture(t);
  const events = [];
  const args = { root, stateDir: root, target: '99', log: (event, data) => events.push({ event, ...data }) };
  let archive = new StoryArchive({ ...args, download: async () => { throw Object.assign(Error(), { code: 'ENOSPC' }); } });
  archive.enqueue([photo]);
  assert.equal(await archive.run(), false);
  assert.equal(archive.state.pending['123'].error, 'NAS_ENOSPC');
  archive = new StoryArchive({ ...args, download: async (_, base) => ({ relativePath: base + '.jpg', bytes: 32 }) });
  assert.equal(await archive.run(), true);
  assert.ok(archive.state.saved['123']);
  archive.enqueue([photo]);
  assert.deepEqual(archive.state.pending, {});
  fs.unlinkSync(archive.file);
  assert.throws(() => new StoryArchive(args), /HISTORY_FILE_MISSING/);
  assert.ok(events.some(row => row.event === 'STORY_ARCHIVE_RETRY'));
  assert.ok(events.some(row => row.event === 'STORY_ARCHIVE_SAVED'));
});
