import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTikTokLink } from '../src/tiktok-links.mjs';
test('TikTok content and share links are canonicalized', () => {
  assert.equal(parseTikTokLink('https://www.tiktok.com/@alice/video/123?tracking=1'), 'https://www.tiktok.com/@alice/video/123');
  assert.equal(parseTikTokLink('https://vt.tiktok.com/ABC/'), 'https://vt.tiktok.com/ABC/');
  assert.equal(parseTikTokLink('tiktok.com/@alice/photo/123'), 'https://tiktok.com/@alice/photo/123');
});
test('rejects unrelated hosts, credentials, profiles and insecure URLs', () => {
  for (const url of ['https://tiktok.com.evil.com/@a/video/1', 'https://user@www.tiktok.com/@a/video/1', 'http://www.tiktok.com/@a/video/1', 'https://www.tiktok.com/@alice', 'https://www.tiktok.com:444/@a/video/1']) assert.throws(() => parseTikTokLink(url));
});

import { tikTokContentPlan } from '../src/tiktok-content-files.mjs';
test('manual output places IG-style caption on media without a separate text message', () => {
  const plan = tikTokContentPlan({ text: 'old text', mediaCaption: '@alice\nhttps://www.tiktok.com/@alice/video/123\ncaption', files: ['tiktok/alice/posts/123/01.mp4'] });
  assert.equal(plan.length, 1);
  assert.equal(plan[0].method, 'sendVideo');
  assert.equal(plan[0].body.caption, '@alice\nhttps://www.tiktok.com/@alice/video/123\ncaption');
  const album = tikTokContentPlan({ text: 'old', mediaCaption: '@alice', files: ['a.mp4', 'b.mp4'] });
  assert.equal(album[0].body.media[0].caption, '@alice');
  assert.equal(album[0].body.media[1].caption, undefined);
});
