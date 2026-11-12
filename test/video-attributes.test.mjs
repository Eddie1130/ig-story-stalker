import test from 'node:test';
import assert from 'node:assert/strict';
import { displayAttributes, videoAttributes, previewSize, videoPreview } from '../src/video-attributes.mjs';
import { ManualDelivery } from '../src/manual-delivery.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const metadata = (extra = {}, format) => ({ streams: [{ width: 720, height: 1280, ...extra }], format });
test('display dimensions account for rotation, pixel aspect ratio and duration', () => {
  assert.deepEqual(displayAttributes(metadata({ duration: '63.2' })), { width: 720, height: 1280, duration: 64 });
  assert.deepEqual(displayAttributes(metadata({ sample_aspect_ratio: '2:1', tags: { rotate: '90' } }, { duration: '5.2' })), { width: 1280, height: 1440, duration: 6 });
  for (const rotation of [-90, 270]) assert.deepEqual(displayAttributes(metadata({ tags: { rotate: 0 }, side_data_list: [{ rotation }] })), { width: 1280, height: 720 });
  for (const sample_aspect_ratio of ['N/A', '0:1', '1:1']) assert.deepEqual(displayAttributes(metadata({ sample_aspect_ratio })), { width: 720, height: 1280 });
});
test('invalid dimensions and arbitrary rotation cannot be represented as a Telegram video', async () => {
  for (const data of [null, {}, metadata({ width: 0 }), metadata({ height: -1 }), metadata({ width: 40000 }), metadata({ tags: { rotate: 45 } }), metadata({ sample_aspect_ratio: '1:0' }), metadata({ sample_aspect_ratio: 'bad' })]) assert.equal(displayAttributes(data), null);
  assert.equal(await videoAttributes('/nonexistent/local-video.mp4'), null);
});
function fixture(t, probe, preview = async () => Buffer.from([255, 216, 255, 217])) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ig-video-display-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'manual'));
  const buffer = Buffer.alloc(32); buffer.write('ftyp', 4); buffer.write('isom', 8);
  fs.writeFileSync(path.join(root, 'manual', 'clip.mp4'), buffer);
  fs.writeFileSync(path.join(root, 'manual', 'photo.jpg'), Buffer.from([255,216,255,...Array(29).fill(0)]));
  const delivery = new ManualDelivery({ root, dir: path.join(root, 'control'), stateDir: root, settings: () => ({}), probe, preview });
  const video = { relativePath: 'manual/clip.mp4', bytes: 32, mediaType: 2, type: 'video', width: 100, height: 100 };
  const photo = { relativePath: 'manual/photo.jpg', bytes: 32, mediaType: 1, type: 'photo' };
  return { delivery, video, photo, result: { username: 'alice', url: 'https://www.instagram.com/p/ABC/', caption: '' } };
}
test('single and album videos use probed final-file dimensions instead of source dimensions', async t => {
  const f = fixture(t, async () => ({ width: 720, height: 1280, duration: 64 }));
  const single = await f.delivery.upload([f.video], f.result, '100', false);
  assert.equal(single.method, 'sendVideo');
  for (const key of ['width', 'height', 'duration']) assert.equal(single.body[key], { width: 720, height: 1280, duration: 64 }[key]);
  const album = await f.delivery.upload([f.photo, f.video], f.result, '100', false);
  assert.equal(album.method, 'sendMediaGroup');
  assert.deepEqual(album.body.media[1], { type: 'video', media: 'attach://media1', supports_streaming: true, width: 720, height: 1280, duration: 64, thumbnail: 'attach://thumb1', cover: 'attach://cover1' });
  assert.equal(single.body.thumbnail, 'attach://thumb0');
  assert.equal(single.body.cover, 'attach://cover0');
  assert.deepEqual(album.files.map(f => f.name), ['media0', 'media1', 'thumb1', 'cover1']);
});
test('unprobed video falls back to documents without changing album boundaries or order', async t => {
  const f = fixture(t, async () => null);
  const single = await f.delivery.upload([f.video], f.result, '100', false);
  assert.equal(single.method, 'sendDocument'); assert.equal(single.body.width, undefined);
  const album = await f.delivery.upload([f.photo, f.video], f.result, '100', false);
  assert.deepEqual(album.body.media.map(m => m.type), ['document', 'document']);
  assert.deepEqual(album.files.map(f => f.filename), ['photo.jpg', 'clip.mp4']);
  assert.ok(album.body.media.every(m => !('supports_streaming' in m) && !('width' in m)));
});
test('preview bounding box preserves portrait, landscape and square display ratios', () => {
  assert.deepEqual(previewSize({ width: 720, height: 1280 }), { width: 180, height: 320 });
  assert.deepEqual(previewSize({ width: 1920, height: 1080 }), { width: 320, height: 180 });
  assert.deepEqual(previewSize({ width: 640, height: 640 }), { width: 320, height: 320 });
  assert.deepEqual(previewSize({ width: 100, height: 200 }), { width: 100, height: 200 });
});
test('failed preview extraction preserves files by sending the original group as documents', async t => {
  const f = fixture(t, async () => ({ width: 720, height: 1280 }), async () => null);
  const upload = await f.delivery.upload([f.photo, f.video], f.result, '100', false);
  assert.deepEqual(upload.body.media.map(m => m.type), ['document', 'document']);
  assert.equal(upload.files.length, 2);
  assert.equal(await videoPreview('/nonexistent/local-video.mp4', { width: 720, height: 1280 }), null);
});
