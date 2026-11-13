import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { xKinds, validXUsername, parseXLink, xLinks, normalizeFxTimeline, normalizeFxPost, normalizeHistory } from '../src/x-model.mjs';
import { XArchive, xFile } from '../src/x-archive.mjs';

const jpeg = Buffer.from([255, 216, 255, ...Array(29).fill(0)]);
const video = Buffer.from([0, 0, 0, 32, 102, 116, 121, 112, ...Array(24).fill(0)]);
const status = (id = '123', extra = {}) => ({ id, type: 'status', author: { screen_name: 'alice' }, text: 'hello', created_timestamp: 1700000000, ...extra });
const event = (id = '123', media = []) => normalizeFxTimeline({ code: 200, results: [status(id, { media: { all: media } })] }, 'alice')[0];
function fixture(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'x-archive-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; }

test('X links accept exact platform hosts and canonicalize a post or profile', () => {
  assert.deepEqual(xKinds, ['post', 'repost', 'reply', 'quote']);
  assert.equal(validXUsername('alice_1'), true); assert.equal(validXUsername('a.b'), false);
  assert.deepEqual(parseXLink('https://www.twitter.com/Alice/status/123?ref=abc'), { kind: 'post', username: 'alice', statusId: '123', url: 'https://x.com/alice/status/123' });
  assert.equal(parseXLink('https://mobile.x.com/Alice/').kind, 'profile');
  assert.equal(xLinks('https://x.com/alice/status/123 https://fxtwitter.com/bob/status/456').length, 2);
  assert.throws(() => xLinks(Array(11).fill('https://x.com/alice/status/123').join(' ')), /X_TOO_MANY_LINKS/);
  for (const url of ['https://x.com.evil/alice', 'https://u@x.com/alice', 'https://x.com:444/alice', 'https://x.com/alice/../bob', 'https://x.com/home', 'https://x.com/alice/status/12/photo/1']) assert.throws(() => parseXLink(url), /X_INVALID_LINK/);
});

test('Fx timeline classifies the four kinds and excludes unrelated thread context', () => {
  const payload = { code: 200, results: [{ type: 'thread', statuses: [status('1'), status('2', { replying_to: { status: '1', screen_name: 'bob' } }), status('3', { quote: status('8', { author: { screen_name: 'bob' } }) }), status('4', { author: { screen_name: 'bob' }, reposted_by: { screen_name: 'Alice' } }), status('9', { author: { screen_name: 'bob' } })] }] };
  const rows = normalizeFxTimeline(payload, 'alice');
  assert.deepEqual(rows.map(r => r.kind), ['post', 'reply', 'quote', 'repost']);
  assert.equal(rows[0].publishedAt, 1700000000000);
  assert.equal(rows[3].authorUsername, 'bob');
  assert.equal(rows[3].url, 'https://x.com/bob/status/4');
});

test('Fx malformed responses are errors rather than successful empty baselines', () => {
  for (const payload of [null, {}, { code: 404 }, { code: 429, results: [] }, { code: 200, results: {} }, { code: 200, results: [{ id: 9007199254740992, author: { screen_name: 'alice' } }] }]) assert.throws(() => normalizeFxTimeline(payload, 'alice'), /X_/);
  assert.deepEqual(normalizeFxTimeline({ code: 200, results: [] }, 'alice'), []);
});

test('Fx manual post validates requested identity and includes quote media in source order', () => {
  const post = status('123', { media: { all: [{ type: 'photo', url: 'https://pbs.twimg.com/media/one.jpg' }, { type: 'video', variants: [{ url: 'https://video.twimg.com/low.mp4', bitrate: 10, content_type: 'video/mp4' }, { url: 'https://video.twimg.com/high.mp4', bitrate: 20, content_type: 'video/mp4' }] }] }, quote: status('456', { author: { screen_name: 'bob' }, media: { photos: [{ url: 'https://pbs.twimg.com/media/two.jpg' }] } }) });
  const row = normalizeFxPost({ code: 200, tweet: post }, parseXLink('https://x.com/alice/status/123'));
  assert.equal(row.media.length, 3); assert.equal(row.media[1].url, 'https://video.twimg.com/high.mp4');
  assert.deepEqual(row.media.map(m => m.sourceId), ['123', '123', '456']);
  assert.match(row.media[0].url, /name=orig/);
  assert.throws(() => normalizeFxPost({ code: 200, tweet: post }, parseXLink('https://x.com/alice/status/999')), /X_/);
});

test('history records normalize to the same IDs and media identities as daily posts', () => {
  const row = normalizeHistory({ id: '123', username: 'Alice', date: '2023-11-14T22:13:20Z', text: 'hello', is_reply: true, media: { images: ['https://pbs.twimg.com/media/a.jpg'], videos: [] }, quoted_tweet: { id: '456', username: 'bob', media: { videos: [{ variants: [{ url: 'https://video.twimg.com/a.mp4', bitrate: 100, content_type: 'video/mp4' }] }] } } }, 'alice');
  assert.equal(row.kind, 'reply'); assert.equal(row.statusId, '123'); assert.equal(row.media[1].sourceId, '456');
  assert.equal(row.publishedAt, 1700000000000);
  assert.throws(() => normalizeHistory({ id: '123', username: 'bob' }, 'alice'), /X_/);
});

test('archive stores text, manifests and media and reuses identity when CDN query changes', async t => {
  const root = fixture(t); let calls = 0;
  const archive = new XArchive({ root, fetchImpl: async (_url, options) => { calls++; assert.equal(options.redirect, 'manual'); assert.equal(options.headers.Cookie, undefined); return new Response(jpeg); } });
  const first = await archive.save(event('123', [{ type: 'photo', url: 'https://pbs.twimg.com/media/a.jpg?tag=one' }]));
  assert.equal(first.errors.length, 0); assert.equal(first.files.length, 1); assert.equal(first.files[0].relativePath, 'x/alice/media/123_01.jpg');
  assert.equal(xFile(root, first.files[0]), path.join(root, first.files[0].relativePath));
  assert.ok(fs.existsSync(path.join(root, 'x/alice/posts/123.json')));
  assert.match(fs.readFileSync(path.join(root, 'x/alice/posts/123.txt'), 'utf8'), /hello/);
  const second = await archive.save(event('123', [{ type: 'photo', url: 'https://pbs.twimg.com/media/a.jpg?tag=two' }]));
  assert.equal(second.files.length, 1); assert.equal(calls, 1);
});

test('archive partial failures retry without redownloading successful media', async t => {
  const root = fixture(t); let fail = true, calls = 0;
  const archive = new XArchive({ root, fetchImpl: async url => { calls++; if (url.includes('two') && fail) return new Response(null, { status: 503 }); return new Response(jpeg); } });
  const row = event('123', [{ type: 'photo', url: 'https://pbs.twimg.com/media/one.jpg' }, { type: 'photo', url: 'https://pbs.twimg.com/media/two.jpg' }]);
  const first = await archive.save(row); assert.equal(first.files.length, 1); assert.equal(first.errors.length, 1);
  fail = false; const second = await archive.save(row); assert.equal(second.files.length, 2); assert.equal(second.errors.length, 0); assert.equal(calls, 3);
});

test('archive blocks SSRF before fetch and validates every redirect', async t => {
  const root = fixture(t); let calls = 0;
  const archive = new XArchive({ root, fetchImpl: async () => { calls++; return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/secret' } }); } });
  const direct = await archive.save(event('1', [{ type: 'photo', url: 'http://127.0.0.1/secret' }]));
  assert.equal(direct.errors.length, 1); assert.equal(calls, 0);
  const redirect = await archive.save(event('2', [{ type: 'photo', url: 'https://pbs.twimg.com/media/a.jpg' }]));
  assert.equal(redirect.errors.length, 1); assert.equal(calls, 1);
});

test('archive rejects wrong signatures, oversized and truncated downloads without complete files', async t => {
  const root = fixture(t);
  for (const [id, response, options] of [['1', new Response('<html>invalid content</html>'), {}], ['2', new Response(jpeg, { headers: { 'content-length': '100' } }), {}], ['3', new Response(jpeg), { maxBytes: 16 }]]) {
    const archive = new XArchive({ root, fetchImpl: async () => response, ...options });
    const result = await archive.save(event(id, [{ type: 'photo', url: 'https://pbs.twimg.com/media/a.jpg' }]));
    assert.equal(result.files.length, 0); assert.equal(result.errors.length, 1);
    assert.equal(fs.existsSync(path.join(root, `x/alice/media/${id}_01.jpg`)), false);
    assert.equal(fs.readdirSync(path.join(root, 'x/alice/media')).some(n => n.endsWith('.part')), false);
  }
});

test('archive checks symlink ancestors, cached file size and safe relative paths', async t => {
  const root = fixture(t), outside = fixture(t); fs.symlinkSync(outside, path.join(root, 'x'));
  const archive = new XArchive({ root, fetchImpl: async () => new Response(jpeg) });
  await assert.rejects(archive.save(event()), /X_UNSAFE_PATH/);
  assert.throws(() => xFile(root, { relativePath: 'x/alice/../../secret', bytes: 32, mediaType: 1 }), /X_UNSAFE_PATH/);
  fs.unlinkSync(path.join(root, 'x'));
  const saved = await archive.save(event('123', [{ type: 'photo', url: 'https://pbs.twimg.com/media/a.jpg' }]));
  fs.writeFileSync(path.join(root, saved.files[0].relativePath), 'broken');
  assert.throws(() => xFile(root, saved.files[0]), /X_FILE_INCOMPLETE/);
});

test('archive stores video signatures and shares quote media across different posts', async t => {
  const root = fixture(t); let calls = 0;
  const archive = new XArchive({ root, fetchImpl: async () => { calls++; return new Response(video); } });
  const embedded = { id: '456', username: 'bob', media: { videos: [{ best_url: 'https://video.twimg.com/a.mp4' }] } };
  for (const id of ['123', '124']) {
    const row = normalizeHistory({ id, username: 'alice', text: 'quote', date: '2024-01-01', media: {}, quoted_tweet: embedded }, 'alice');
    const saved = await archive.save(row); assert.equal(saved.files[0].relativePath, 'x/alice/media/456_1001.mp4');
  }
  assert.equal(calls, 1);
});

test('history repost ID and embedded original media match a daily repost', () => {
  const row = normalizeHistory({ id: '999', username: 'alice', date: '2024-01-01', retweeted_tweet: { id: '123', username: 'bob', text: 'original', media: { images: ['https://pbs.twimg.com/media/a.jpg'] } } }, 'alice');
  const daily = normalizeFxTimeline({ results: [status('123', { author: { screen_name: 'bob' }, reposted_by: { screen_name: 'alice' }, text: 'original', media: { photos: [{ url: 'https://pbs.twimg.com/media/a.jpg' }] } })] }, 'alice')[0];
  assert.equal(row.kind, daily.kind); assert.equal(row.statusId, daily.statusId); assert.deepEqual(row.media, daily.media);
});

test('malformed identities and unknown media cannot become a baseline', () => {
  for (const row of [status('1', { author: null }), status('1', { media: { all: [{ type: 'unsupported' }] } }), status('1', { media: { videos: [{}] } })]) assert.throws(() => normalizeFxTimeline({ results: [row] }, 'alice'), /X_/);
  assert.throws(() => normalizeFxTimeline({ results: [{ type: 'thread', statuses: null }] }, 'alice'), /X_/);
});

test('xLinks handles punctuation and rejects excessive or invalid platform links', () => {
  assert.deepEqual(xLinks('Read (https://x.com/Alice/status/123).'), [parseXLink('https://x.com/alice/status/123')]);
  assert.deepEqual(xLinks('https://instagram.com/alice https://example.com'), []);
  assert.throws(() => xLinks('https://x.com/intent'), /X_INVALID_LINK/);
  assert.throws(() => parseXLink('not a url'), /X_INVALID_LINK/);
});

test('archive follows safe redirects and enforces redirect limit and headers', async t => {
  const root = fixture(t); let calls = 0;
  const archive = new XArchive({ root, fetchImpl: async () => ++calls === 1 ? new Response(null, { status: 302, headers: { location: '/media/b.jpg' } }) : new Response(jpeg) });
  assert.equal((await archive.save(event('1', [{ type: 'photo', url: 'https://pbs.twimg.com/media/a.jpg' }]))).files.length, 1);
  for (const [id, fetchImpl] of [
    ['2', async () => new Response(null, { status: 302, headers: { location: '/media/a.jpg' } })],
    ['3', async () => new Response(null, { status: 302 })],
    ['4', async () => new Response(jpeg, { headers: { 'content-encoding': 'gzip' } })],
    ['5', async () => new Response(null)],
  ]) {
    const bad = new XArchive({ root, fetchImpl });
    assert.equal((await bad.save(event(id, [{ type: 'photo', url: 'https://pbs.twimg.com/media/a.jpg' }]))).errors.length, 1);
  }
});

test('archive rejects malformed event paths and incomplete cached signatures', async t => {
  const root = fixture(t), archive = new XArchive({ root });
  for (const bad of [{ ...event(), statusId: '../1' }, { ...event(), targetUsername: '../alice' }, { ...event(), media: Array(101).fill({}) }]) await assert.rejects(archive.save(bad), /X_INVALID_EVENT/);
  assert.throws(() => new XArchive({ root: 'relative' }), /X_INVALID_ARCHIVE_CONFIG/);
  fs.mkdirSync(path.join(root, 'x/alice/media'), { recursive: true });
  fs.writeFileSync(path.join(root, 'x/alice/media/123_01.jpg'), Buffer.alloc(32));
  assert.throws(() => xFile(root, { relativePath: 'x/alice/media/123_01.jpg', bytes: 32, mediaType: 1 }), /X_FILE_INCOMPLETE/);
});

test('mixed photo/video history reuses interleaved daily media without identity collisions', async t => {
  const root = fixture(t); let calls = 0;
  const archive = new XArchive({ root, fetchImpl: async url => { calls++; return new Response(url.includes('video.twimg.com') ? video : jpeg); } });
  const rows = [{ type: 'photo', url: 'https://pbs.twimg.com/media/one.jpg' }, { type: 'video', url: 'https://video.twimg.com/one.mp4' }, { type: 'photo', url: 'https://pbs.twimg.com/media/two.jpg' }];
  const daily = event('123', rows); assert.deepEqual(daily.media.map(m => m.index), [1, 1001, 2]);
  const first = await archive.save(daily); assert.equal(first.files.length, 3);
  const historical = normalizeHistory({ id: '123', username: 'alice', media: { images: [rows[0].url, rows[2].url], videos: [{ best_url: rows[1].url }] } }, 'alice');
  const second = await archive.save(historical); assert.equal(second.files.length, 3); assert.equal(calls, 3);
  assert.deepEqual(new Set(first.files.map(f => f.relativePath)), new Set(second.files.map(f => f.relativePath)));
  const ordered = normalizeHistory({ id: '123', username: 'alice', media: {}, raw_twscrape: { media: { all: rows } } }, 'alice');
  assert.deepEqual(ordered.media.map(m => m.index), [1, 1001, 2]);
});
