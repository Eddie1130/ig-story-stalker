import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mainMenu, applyUpdate } from '../src/telegram-menu.mjs';
import { initializeSettings, validateSettings, mediaEnabled } from '../src/telegram-settings.mjs';
import { flushReplies } from '../src/telegram-replies.mjs';
import { TelegramClient } from '../src/telegram-client.mjs';
import { updateNotice, noticeRecipients } from '../src/telegram-notices.mjs';
import { PersonalDelivery } from '../src/telegram-delivery.mjs';
import { XDelivery } from '../src/x-delivery.mjs';
import { TikTokDelivery } from '../src/tiktok-delivery.mjs';
import { platformMenu } from '../src/platform-menu.mjs';
import { platformStatus } from '../src/platform-status.mjs';
import { simpleXHistory } from '../src/x-status.mjs';
import { describeUser } from '../src/telegram-control.mjs';
import { atomic, load } from '../src/error-monitor.mjs';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-ux-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const settings = initializeSettings({ IG_CONTROL_DIR: dir, TELEGRAM_CHAT_ID: '100', TELEGRAM_ALLOWED_USER_IDS: '200', IG_TARGET_USERNAMES: 'alice' }, 1000);
  return { dir, settings };
}
const click = (id, data) => ({ update_id: id, callback_query: { id: String(id), from: { id: 100 }, message: { message_id: 42, chat: { id: 100, type: 'private' } }, data } });
const reply = (settings, id) => settings.replies[`reply:${id}`];

test('five-entry home, direct platform lists, support descriptions and no download entry', t => {
  const { settings } = fixture(t);
  const buttons = mainMenu(settings.users['100']).reply_markup.inline_keyboard.flat();
  assert.deepEqual(buttons.map(b => b.callback_data), ['ig:menu', 'x:menu', 'tt:menu', 'notifications', 'status']);
  assert.match(mainMenu(settings.users['100']).text, /直接傳送/);
  const status = () => '';
  status.platform = () => ({ accounts: { alice: '🟢 @alice · 正常' } });
  for (const [i, platform] of ['ig', 'x', 'tt'].entries()) {
    applyUpdate(settings, click(i + 1, `${platform}:menu`), 2000, status);
    assert.match(reply(settings, i + 1).body.text, /支援：/);
    assert.ok(reply(settings, i + 1).body.reply_markup.inline_keyboard.flat().some(b => /新增/.test(b.text)));
    assert.ok(reply(settings, i + 1).body.reply_markup.inline_keyboard.flat().every(b => !/download/.test(b.callback_data)));
  }
  assert.match(reply(settings, 1).body.text, /🟢 @alice · 正常/);
});

test('callback navigation and setting changes edit their message; queued older edits are superseded', async t => {
  const { settings } = fixture(t);
  applyUpdate(settings, click(1, 'status'), 2000, () => 'old status');
  applyUpdate(settings, click(2, 'notifications'), 2100);
  applyUpdate(settings, click(3, 'daily:1'), 2200);
  assert.equal(reply(settings, 3).method, 'editMessageText');
  assert.equal(reply(settings, 3).body.message_id, 42);
  const calls = [];
  await flushReplies(settings, { call: async (method, body) => calls.push({ method, body }) }, () => {});
  const edits = calls.filter(c => c.method === 'editMessageText');
  assert.equal(edits.length, 1);
  assert.match(edits[0].body.text, /全域通知/);
  assert.equal(settings.users['100'].daily, true);
});

test('deleted menus fall back once, while network edit errors only retry the edit', async t => {
  const { settings } = fixture(t);
  applyUpdate(settings, click(1, 'menu'), 2000);
  const calls = [];
  await flushReplies(settings, { call: async method => {
    calls.push(method);
    if (method === 'editMessageText') throw Object.assign(Error('TELEGRAM_ERROR_400'), { messageUnavailable: true });
  } }, () => {});
  assert.equal(reply(settings, 1).method, 'sendMessage');
  await flushReplies(settings, { call: async method => calls.push(method) }, () => {});
  assert.deepEqual(calls, ['answerCallbackQuery', 'editMessageText', 'sendMessage']);
  applyUpdate(settings, click(2, 'status'), 3000);
  await flushReplies(settings, { call: async method => { if (method === 'editMessageText') throw Error('TELEGRAM_NETWORK_OR_RESPONSE_ERROR'); } }, () => {});
  assert.equal(reply(settings, 2).method, 'editMessageText');
  assert.ok(reply(settings, 2).retryAt > Date.now());
});

test('Telegram no-op edit and already deleted notice are acknowledged without hiding unrelated 400s', async t => {
  const { dir } = fixture(t);
  let description = 'Bad Request: message is not modified: specified new message content is the same';
  const client = new TelegramClient({ token: '1:abc', dir, sleep: async () => {}, fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({ ok: false, error_code: 400, description }) }) });
  assert.equal(await client.call('editMessageText', {}), true);
  description = 'Bad Request: message to delete not found';
  assert.equal(await client.call('deleteMessage', {}), true);
  description = 'Bad Request: message to edit not found';
  await assert.rejects(client.call('editMessageText', {}), e => e.messageUnavailable === true);
  description = 'Bad Request: chat not found';
  await assert.rejects(client.call('editMessageText', {}), e => !e.messageUnavailable);
});

test('global switch preserves account preferences, is personal, and never backfills disabled periods', t => {
  const { settings, dir } = fixture(t), user = settings.users['100'];
  const original = structuredClone(user.targets.alice.notifications);
  applyUpdate(settings, click(1, 'media:0'), 2000);
  assert.equal(mediaEnabled(user, 2500), false);
  assert.equal(mediaEnabled(settings.users['200'], 2500), true);
  applyUpdate(settings, click(2, 'media:1'), 3000);
  assert.deepEqual(user.targets.alice.notifications, original);
  assert.equal(mediaEnabled(user, 2500), false);
  assert.equal(mediaEnabled(user, 3500), true);
  validateSettings(settings);
  const delivery = new PersonalDelivery({ dir, stateDir: dir, settings: () => settings });
  const event = at => ({ version: 1, type: 'media', username: 'alice', target: '123', at, publishedAt: 3500, id: String(at), kind: 'post', method: 'sendPhoto', body: { photo: 'https://s.cdninstagram.com/a.jpg', caption: 'post' } });
  delivery.ingest(event(2500));
  assert.equal(Object.keys(delivery.state.pending).length, 0);
  delivery.ingest(event(3500));
  assert.equal(Object.keys(delivery.state.pending).length, 1);
});

test('incident messages update, survive restart, delete on recovery and ignore out-of-order failures', async () => {
  let state = {}, id = 1;
  const calls = [], client = { call: async (method, body) => { calls.push({ method, ...body }); return { message_id: id++ }; } };
  const key = JSON.stringify(['100', 'fetch']);
  await updateNotice(client, state, key, { userId: '100', at: 1, text: 'failed' }, () => {});
  state = JSON.parse(JSON.stringify(state));
  await updateNotice(client, state, key, { userId: '100', at: 2, text: 'still failed' }, () => {});
  state.notices[key].messages.push(99); // Older paired notification with a recorded ID.
  await updateNotice(client, state, key, { userId: '100', at: 3, recovery: true }, () => {});
  await updateNotice(client, state, key, { userId: '100', at: 1, text: 'stale' }, () => {});
  assert.deepEqual(calls.map(c => c.method), ['sendMessage', 'editMessageText', 'deleteMessage', 'deleteMessage']);
  assert.deepEqual(calls.filter(c => c.method === 'deleteMessage').map(c => c.message_id), [1, 99]);
  assert.deepEqual(noticeRecipients({ notices: { [key]: { messages: [1] } } }, { noticeKind: 'recovery', noticeKey: 'fetch', recipients: [] }), [{ userId: '100', generation: 'notice-cleanup' }]);
});

test('failed notice deletion retries without resending a warning or skipping remaining IDs', async () => {
  const key = JSON.stringify(['100', 'fetch']), state = { notices: { [key]: { at: 1, messages: [7, 8] } } };
  let fail = true;
  const calls = [], client = { call: async (method, body) => { calls.push([method, body.message_id]); if (body.message_id === 8 && fail) throw Error('TELEGRAM_ERROR_429'); } };
  const event = { userId: '100', at: 2, recovery: true };
  await assert.rejects(updateNotice(client, state, key, event, () => {}));
  assert.deepEqual(state.notices[key].messages, [8]);
  fail = false;
  await updateNotice(client, state, key, event, () => {});
  assert.deepEqual(calls, [['deleteMessage', 7], ['deleteMessage', 8], ['deleteMessage', 8]]);
});

test('uncertain initial notice sends are not repeated after network loss or restart', async () => {
  const state = {}, key = JSON.stringify(['100', 'fetch']); let calls = 0;
  const client = { call: async (_method, _body, options) => { calls++; options.beforeRequest(); throw Error('TELEGRAM_NETWORK_OR_RESPONSE_ERROR'); } };
  await updateNotice(client, state, key, { userId: '100', at: 1, text: 'failed' }, () => {});
  await updateNotice(client, JSON.parse(JSON.stringify(state)), key, { userId: '100', at: 2, text: 'failed' }, () => {});
  assert.equal(calls, 1);
});

test('TikTok counts and status are scoped to this user and LIVE/content share one line', t => {
  const { settings, dir } = fixture(t);
  settings.users['100'].tiktokTargets = { alice: { notifications: { post: { enabled: true } } } };
  atomic(path.join(dir, 'tiktok/catalog/health.json'), { at: Date.now(), pending: 999, targets: { alice: { post: { phase: '監看中', pending: 3 } }, bob: { post: { pending: 996 } } } });
  atomic(path.join(dir, 'tiktok/health.json'), { at: Date.now(), targets: { alice: { phase: '錄影中' } } });
  const a = platformStatus(settings.users['100'], 'tt', dir, load), b = platformStatus(settings.users['200'], 'tt', dir, load);
  assert.equal(a.pending, 3); assert.equal(b.pending, 0);
  assert.match(a.accounts.alice, /內容正常 · LIVE 錄影中/);
  assert.doesNotMatch(a.text, /bob|999|996/);
  const text = describeUser(settings, '100', dir);
  assert.match(text, /Instagram/); assert.match(text, /X \/ Twitter/); assert.match(text, /TikTok/);
  assert.doesNotMatch(text, /歷史回補/);
});

test('simple history uses measured archive speed only; unknown, waiting and stale estimates remain honest', () => {
  const now = 1_000_000;
  const job = { username: 'alice', phase: 'archive', status: 'complete', archive: { unit: 'post', total: 100, done: 50, failed: 0 }, archiveStartedAt: now - 60000, archiveStartedDone: 40, progressUpdatedAt: now };
  assert.match(simpleXHistory(job, now), /預計完成：約 .*香港時間/);
  assert.match(simpleXHistory({ ...job, status: 'retry' }, now), /暫時無法估算/);
  assert.match(simpleXHistory({ ...job, progressUpdatedAt: now - 360000 }, now), /暫時無法估算/);
  assert.match(simpleXHistory({ username: 'alice', phase: 'search', progress: { completedWindows: 4, totalWindows: 10 } }, now), /搜尋歷史貼文 · 40%/);
});

test('X and TikTok recoveries clean up notifications even after subscription removal', async t => {
  const { settings, dir } = fixture(t);
  for (const [Delivery, folder, event] of [
    [XDelivery, 'x', { version: 1, type: 'notice', id: 'recovery', at: 3, username: 'alice', text: '', recipients: [], noticeKey: 'fetch:alice', noticeKind: 'recovery' }],
    [TikTokDelivery, 'tiktok', { username: 'alice', kind: 'notice', at: 3, text: '', files: [], recipients: [], noticeKey: 'fetch:alice', noticeKind: 'recovery' }],
  ]) {
    const delivery = new Delivery({ root: dir, dir, stateDir: dir, settings: () => settings });
    delivery.state.notices = { [JSON.stringify(['100', 'fetch:alice'])]: { at: 1, messages: [77] } };
    const calls = [];
    atomic(path.join(dir, folder, 'events', 'a'.repeat(64) + '.json'), event);
    await delivery.drain({ call: async (method, body) => calls.push({ method, ...body }) });
    assert.deepEqual(calls, [{ method: 'deleteMessage', chat_id: '100', message_id: 77 }]);
  }
});

test('repeated enable callbacks preserve the cutoff and navigating away cancels account entry', t => {
  const { settings } = fixture(t), user = settings.users['100'];
  applyUpdate(settings, click(1, 'media:0'), 2000);
  applyUpdate(settings, click(2, 'media:1'), 3000);
  applyUpdate(settings, click(3, 'media:1'), 4000);
  assert.equal(user.mediaNotificationsSince, 3000);
  assert.equal(mediaEnabled(user, 3500), true);
  applyUpdate(settings, click(4, 'add'), 5000);
  assert.equal(user.waiting, 'add');
  applyUpdate(settings, click(5, 'notifications'), 6000);
  assert.equal(user.waiting, undefined);
});

test('watchdog fallback IDs persist and are cleared without a recovery message', async () => {
  const { sendControlFallback, clearControlFallback } = await import('../src/telegram-fallback.mjs');
  const state = {}, calls = [];
  const options = { state, recipients: ['100', '200'], ownerId: '100', token: 'test', signal: new AbortController().signal, persist() {}, log() {},
    fetchImpl: async (url, options) => {
      calls.push({ method: url.split('/').at(-1), ...JSON.parse(options.body) });
      return { ok: true, json: async () => ({ ok: true, result: { message_id: 77 } }) };
    } };
  await sendControlFallback(options);
  assert.deepEqual(state.controlFallbackMessages, { 100: [77], 200: [77] });
  await clearControlFallback(options);
  assert.deepEqual(calls.map(c => c.method), ['sendMessage', 'sendMessage', 'deleteMessage', 'deleteMessage']);
  assert.deepEqual(state.controlFallbackMessages, {});
  assert.equal(state.controlFallbackSent, undefined);
});

test('one blocked fallback recipient never prevents another cleanup or the next incident alert', async () => {
  const { clearControlFallback, sendControlFallback } = await import('../src/telegram-fallback.mjs');
  const state = { controlFallbackSent: { 100: true, 200: true }, controlFallbackMessages: { 100: [1], 200: [2] } }, calls = [];
  const options = { state, token: 'test', signal: new AbortController().signal, persist() {}, log() {}, recipients: ['100', '200'], ownerId: '100',
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body); calls.push([url.split('/').at(-1), body.chat_id]);
      return body.chat_id === '100' ? { ok: false, status: 403, json: async () => ({ ok: false, error_code: 403 }) } : { ok: true, json: async () => ({ ok: true, result: { message_id: 88 } }) };
    } };
  assert.equal(await clearControlFallback(options), false);
  assert.deepEqual(calls, [['deleteMessage', '100'], ['deleteMessage', '200']]);
  assert.deepEqual(state.controlFallbackMessages, { 100: [1] });
  assert.equal(state.controlFallbackSent, undefined);
  await sendControlFallback(options);
  assert.ok(calls.some(([method, user]) => method === 'sendMessage' && user === '200'));
});

test('typed account input continues the existing prompt instead of sending another menu', async t => {
  const { settings } = fixture(t);
  applyUpdate(settings, click(1, 'add'), 2000);
  assert.equal(settings.users['100'].waitingMessageId, 42);
  applyUpdate(settings, { update_id: 2, message: { from: { id: 100 }, chat: { id: 100, type: 'private' }, text: '@new_account' } }, 3000);
  assert.equal(reply(settings, 2).method, 'editMessageText');
  assert.equal(reply(settings, 2).body.message_id, 42);
  assert.ok(settings.users['100'].targets.new_account);
  assert.equal(settings.users['100'].waitingMessageId, undefined);
  validateSettings(settings);
});

test('replacement input prompts retain the new message identity', async t => {
  const { settings } = fixture(t);
  applyUpdate(settings, click(1, 'add'), 2000);
  await flushReplies(settings, { call: async method => {
    if (method === 'editMessageText') throw Object.assign(Error('TELEGRAM_ERROR_400'), { messageUnavailable: true });
  } }, () => {});
  await flushReplies(settings, { call: async () => ({ message_id: 99 }) }, () => {});
  assert.equal(settings.users['100'].waitingMessageId, 99);
});


test('Instagram submenu shows per-account scan and discovered media archival progress', t => {
  const { settings, dir } = fixture(t), user = settings.users['100'];
  atomic(path.join(dir, 'health.json'), { at: Date.now(), targets: [{ username: 'alice', target: '123', failures: 0 }] });
  const catalog = { posts: { baseline: false, failures: 0 }, highlights: { baseline: true, failures: 0, todo: [] }, assets: { a: { archiveDone: true }, b: { archiveDone: false } } };
  atomic(path.join(dir, 'catalog-123.json'), catalog);
  let overview = platformStatus(user, 'ig', dir, load);
  const menu = platformMenu(user, 'ig', 0, overview);
  assert.match(menu.text, /@alice · 正常\n回補：貼文搜尋中\n封存：1\/2 個已發現媒體/);
  assert.doesNotMatch(menu.text, /%/);
  catalog.posts.failures = 1;
  atomic(path.join(dir, 'catalog-123.json'), catalog);
  assert.match(platformStatus(user, 'ig', dir, load).backfills.alice, /等待重試/);
  catalog.posts.baseline = true; catalog.posts.failures = 0;
  atomic(path.join(dir, 'catalog-123.json'), catalog);
  assert.match(platformStatus(user, 'ig', dir, load).backfills.alice, /掃描完成/);
  catalog.assets.b.archiveDone = true;
  atomic(path.join(dir, 'catalog-123.json'), catalog);
  overview = platformStatus(user, 'ig', dir, load);
  assert.equal(overview.backfills.alice, undefined);
  assert.doesNotMatch(platformMenu(user, 'ig', 0, overview).text, /回補：/);
});

test('X submenu shows scoped active progress and requests not yet picked up by the worker', t => {
  const { settings, dir } = fixture(t), user = settings.users['100'];
  user.xTargets = { alice: {}, carol: {} };
  settings.xRequests = {
    '100-1-0': { id: '100-1-0', userId: '100', username: 'carol', type: 'history', at: 2000 },
    '200-2-0': { id: '200-2-0', userId: '200', username: 'bob', type: 'history', at: 3000 },
  };
  const health = { at: Date.now(), targets: [{ username: 'alice' }, { username: 'carol' }], historyJobs: [
    { id: 'a', username: 'alice', status: 'working', phase: 'search', progress: { completedWindows: 4, totalWindows: 10 } },
    { id: 'b', username: 'bob', status: 'working', phase: 'search' },
  ] };
  atomic(path.join(dir, 'x/health.json'), health);
  let overview = platformStatus(user, 'x', dir, load, Date.now(), { settings, id: '100' });
  let menu = platformMenu(user, 'x', 0, overview);
  assert.match(menu.text, /@alice · 正常\n回補：搜尋歷史貼文 · 40%\n預計完成：暫時無法估算/);
  assert.match(menu.text, /@carol · 正常\n回補：排隊中/);
  assert.doesNotMatch(menu.text, /bob/);
  health.historyJobs[0] = { id: 'a', username: 'alice', status: 'complete', phase: 'finished', reported: true };
  atomic(path.join(dir, 'x/health.json'), health);
  overview = platformStatus(user, 'x', dir, load, Date.now(), { settings, id: '100' });
  assert.equal(overview.backfills.alice, undefined);
  menu = platformMenu(user, 'x', 0, overview);
  assert.match(menu.text, /@carol · 正常\n回補：排隊中/);
});

test('submenu backfills stay on their account page and mark stale snapshots', t => {
  const { dir } = fixture(t), user = { xTargets: Object.fromEntries(Array.from({ length: 9 }, (_, i) => ['user' + i, {}])) };
  atomic(path.join(dir, 'x/health.json'), { at: Date.now() - 300000, historyJobs: [{ username: 'user8', status: 'queued' }] });
  const overview = platformStatus(user, 'x', dir, load);
  assert.doesNotMatch(platformMenu(user, 'x', 0, overview).text, /回補：/);
  assert.ok(platformMenu(user, 'x', 1, overview).reply_markup.inline_keyboard.flat().some(b => b.text === '🔄 重新整理' && b.callback_data === 'x:list:1'));
  assert.match(platformMenu(user, 'x', 1, overview).text, /@user8.*\n回補：排隊中 · 狀態未更新/);
});


test('stale worker snapshots never show a calculated backfill completion estimate', t => {
  const { dir } = fixture(t), now = Date.now(), user = { xTargets: { alice: {} } };
  atomic(path.join(dir, 'x/health.json'), { at: now - 300000, historyJobs: [{ username: 'alice', status: 'complete', phase: 'archive', reported: false,
    archive: { unit: 'post', done: 50, total: 100 }, archiveStartedAt: now - 60000, archiveStartedDone: 40, progressUpdatedAt: now }] });
  const overview = platformStatus(user, 'x', dir, load, now);
  assert.match(overview.backfills.alice, /預計完成：暫時無法估算 · 狀態未更新/);
});
