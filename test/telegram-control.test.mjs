import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initializeSettings, settingsFile, readSettings, targetConfigs, subscription, alertRecipients } from '../src/telegram-settings.mjs';
import { applyUpdate, mainMenu } from '../src/telegram-menu.mjs';
import { PersonalDelivery, localDay } from '../src/telegram-delivery.mjs';
import { TelegramClient } from '../src/telegram-client.mjs';
import { atomic } from '../src/error-monitor.mjs';
import { main } from '../src/watch-media.mjs';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ig-telegram-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const control = path.join(dir, 'control'), state = path.join(dir, 'state'), root = path.join(dir, 'downloads');
  fs.mkdirSync(state); fs.mkdirSync(root);
  const env = { TELEGRAM_CHAT_ID: '100', TELEGRAM_ALLOWED_USER_IDS: '200', IG_TARGET_USERNAMES: 'alice,bob', IG_CONTROL_DIR: control };
  const settings = initializeSettings(env, 1000);
  const delivery = new PersonalDelivery({ dir: control, stateDir: state, settings: () => settings });
  return { dir, control, state, root, env, settings, delivery };
}
const story = { id: '789', mediaType: 1, mediaUrl: 'https://s.cdninstagram.com/a.jpg', takenAt: 1700000000, expiringAt: null };
const snapshot = (at, stories = [story]) => ({ version: 1, type: 'stories', username: 'alice', target: '101', at, stories });
const post = (at, kind = 'post') => ({ version: 1, type: 'media', username: 'alice', target: '101', at, publishedAt: at, id: `${kind}:1:2`, kind,
  method: 'sendPhoto', body: { photo: story.mediaUrl, caption: '@alice\nnew media' } });
const message = (n, id, text, type = 'private') => ({ update_id: n, message: { from: { id }, chat: { id, type }, text } });
const callback = (n, id, data) => ({ update_id: n, callback_query: { id: String(n), from: { id }, message: { chat: { id, type: 'private' } }, data } });

// Configuration and updates are local-only; all Telegram/Instagram network boundaries are fixtures.
test('owner import happens once; independent users, revocation, and required state survive restart', t => {
  const f = fixture(t);
  assert.deepEqual(targetConfigs(f.settings).map(t => t.username), ['alice', 'bob']);
  f.settings.users['100'].targets = {}; atomic(settingsFile(f.env), f.settings);
  const restarted = initializeSettings({ ...f.env, IG_TARGET_USERNAMES: 'charlie' }, 2000);
  assert.deepEqual(targetConfigs(restarted), [], 'environment must not restore removed subscriptions');
  restarted.users['200'].targets.alice = subscription(2000); atomic(settingsFile(f.env), restarted);
  assert.equal(targetConfigs(readSettings(settingsFile(f.env))).length, 1);
  const revoked = initializeSettings({ ...f.env, TELEGRAM_ALLOWED_USER_IDS: '' }, 3000);
  assert.equal(targetConfigs(revoked).length, 0);
  fs.unlinkSync(settingsFile(f.env));
  assert.throws(() => initializeSettings(f.env), /HISTORY_MISSING/);
});

test('private-chat identity and whitelist checks reject unauthorized/group/forged callbacks', t => {
  const { settings: s } = fixture(t);
  for (const update of [message(1, 999, '/add evil'), message(2, 100, '/add evil', 'group'),
    { ...callback(3, 100, 'daily:1'), callback_query: { ...callback(3, 100, 'daily:1').callback_query, message: { chat: { id: 200, type: 'private' } } } }]) {
    applyUpdate(s, update, 2000);
  }
  assert.equal(s.users['100'].daily, false); assert.equal(Object.keys(s.replies).length, 0);
  applyUpdate(s, message(4, 200, '/add @Alice'), 2000);
  assert.ok(s.users['200'].targets.alice); assert.equal(s.users['100'].targets.alice.joinedAt, 1000);
});

test('menu adds, independently configures, confirms removal, and rejects stale/replayed buttons', t => {
  const { settings: s } = fixture(t);
  applyUpdate(s, callback(1, 200, 'add'), 2000);
  applyUpdate(s, message(2, 200, '@ALICE'), 2100);
  const sub = s.users['200'].targets.alice, gen = sub.generation.slice(0, 8);
  applyUpdate(s, callback(3, 200, `set:alice:post:0:${gen}`), 2200);
  assert.equal(sub.notifications.post.enabled, false); assert.equal(s.users['100'].targets.alice.notifications.post.enabled, true);
  applyUpdate(s, callback(4, 200, `remove:alice:${gen}`), 2300);
  assert.ok(s.users['200'].targets.alice, 'removal requires confirmation');
  applyUpdate(s, callback(5, 200, `delete:alice:${gen}`), 2400);
  assert.equal(s.users['200'].targets.alice, undefined); assert.ok(s.users['100'].targets.alice);
  applyUpdate(s, message(6, 200, '/add alice'), 2500);
  applyUpdate(s, callback(7, 200, `delete:alice:${gen}`), 2600);
  assert.ok(s.users['200'].targets.alice, 'old button cannot remove a new subscription');
  const before = structuredClone(s);
  assert.equal(applyUpdate(s, message(6, 200, '/add bob')), false); assert.deepEqual(s, before);
  for (const reply of Object.values(s.replies)) for (const row of reply.body.reply_markup?.inline_keyboard || [])
    for (const button of row) assert.ok(Buffer.byteLength(button.callback_data) <= 64);
  assert.ok(mainMenu(s.users['100']).reply_markup.inline_keyboard.length >= 3);
});

test('two users share events but acknowledge and retry media independently across restart', async t => {
  const f = fixture(t), s = f.settings;
  s.users['200'].targets.alice = subscription(1000);
  f.delivery.ingest(post(2000));
  const calls = [];
  await f.delivery.drain({ call: async (_method, body) => { calls.push(body.chat_id); if (body.chat_id === '100') throw Error('TELEGRAM_ERROR_500'); } });
  assert.deepEqual(calls, ['100', '200']); assert.equal(Object.keys(f.delivery.state.pending).length, 1);
  const restarted = new PersonalDelivery({ dir: f.control, stateDir: f.state, settings: () => s });
  for (const task of Object.values(restarted.state.pending)) task.retryAt = 0;
  await restarted.drain({ call: async (_method, body) => calls.push(body.chat_id) });
  restarted.ingest(post(2000));
  assert.deepEqual(calls, ['100', '200', '100']); assert.equal(Object.keys(restarted.state.pending).length, 0);
});

test('disabled notifications do not backfill, including pending media and later Story snapshots', async t => {
  const f = fixture(t), sub = f.settings.users['100'].targets.alice;
  sub.notifications.post.enabled = false;
  f.delivery.ingest(post(2000)); assert.equal(Object.keys(f.delivery.state.pending).length, 0);
  sub.notifications.post = { enabled: true, since: 3000 };
  f.delivery.ingest(post(2000)); assert.equal(Object.keys(f.delivery.state.pending).length, 0);
  f.delivery.ingest(post(4000)); assert.equal(Object.keys(f.delivery.state.pending).length, 1);
  sub.notifications.post.enabled = false;
  await f.delivery.drain({ call: () => assert.fail('pending item must be cancelled') });
  sub.notifications.story.enabled = false;
  f.delivery.ingest(snapshot(2000));
  sub.notifications.story = { enabled: true, since: 3000 };
  f.delivery.ingest(snapshot(4000));
  assert.equal(Object.keys(f.delivery.state.pending).length, 0, 'existing Stories are not backfilled after enabling');
  f.delivery.ingest(snapshot(5000, [{ ...story, id: '790' }]));
  assert.equal(Object.keys(f.delivery.state.pending).length, 1);
});

test('new subscriber gets currently available Stories even for an already monitored account, not old posts', async t => {
  const f = fixture(t), sent = [];
  f.delivery.ingest(snapshot(2000));
  await f.delivery.drain({ call: async (_method, body) => sent.push(body.chat_id) });
  f.settings.users['200'].targets.alice = subscription(3000);
  f.delivery.ingest(post(2000));
  f.delivery.ingest(snapshot(4000));
  await f.delivery.drain({ call: async (_method, body) => sent.push(body.chat_id) });
  assert.equal(sent.filter(id => id === '200').length, 1);
  assert.equal(sent.filter(id => id === '100').length, 2, 'original subscriber received Story and eligible post once each');
});

test('removing last subscriber stops the target union and cancels queued media without deleting files', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, 'kept.jpg'), 'local');
  f.delivery.ingest(post(2000));
  delete f.settings.users['100'].targets.alice;
  assert.deepEqual(targetConfigs(f.settings).map(t => t.username), ['bob']);
  await f.delivery.drain({ call: () => assert.fail('removed subscriber must not receive queued media') });
  assert.equal(fs.readFileSync(path.join(f.root, 'kept.jpg'), 'utf8'), 'local');
});

test('account alerts are scoped and shared storage/session failures reach all approved users', t => {
  const { settings: s } = fixture(t);
  assert.deepEqual(alertRecipients(s, { username: 'alice', issueKey: 'target:alice:fetch', reason: 'FETCH_TIMEOUT' }), ['100']);
  assert.deepEqual(alertRecipients(s, { username: 'alice', issueKey: 'target:alice:nas-storage', reason: 'NAS_ENOSPC' }), ['100', '200']);
  assert.deepEqual(alertRecipients(s, { issueKey: 'shared-session', reason: 'SESSION_INVALID' }), ['100', '200']);
});

test('daily summary is opt-in at Hong Kong 20:00 and only queued once per local day across restart', t => {
  const f = fixture(t), now = Date.parse('2026-11-12T12:00:00Z');
  f.settings.users['200'].daily = true;
  f.delivery.daily(now - 1, id => 'summary for ' + id);
  assert.equal(Object.keys(f.delivery.state.pending).length, 0);
  f.delivery.daily(now, id => 'summary for ' + id);
  const restarted = new PersonalDelivery({ dir: f.control, stateDir: f.state, settings: () => f.settings });
  restarted.daily(now + 10000, () => 'duplicate');
  assert.equal(Object.keys(restarted.state.pending).length, 1);
  assert.equal(Object.values(restarted.state.pending)[0].userId, '200');
  assert.equal(localDay(now), '2026-11-12');
});

test('legacy Story sent records migrate without resending previously delivered Stories', async t => {
  const f = fixture(t);
  fs.unlinkSync(path.join(f.control, 'delivery.json')); fs.unlinkSync(path.join(f.control, 'delivery.json.required'));
  atomic(path.join(f.state, 'archive-layout.json'), { accounts: { 101: 'alice' } });
  atomic(path.join(f.state, 'watch-media-101.json'), { sent: { 789: 1500 } });
  const d = new PersonalDelivery({ dir: f.control, stateDir: f.state, settings: () => f.settings });
  d.ingest(snapshot(2000));
  await d.drain({ call: () => assert.fail('already delivered Story must not resend') });
});

test('Telegram retry_after is persisted and shared by polling and media requests', async t => {
  const f = fixture(t); let requests = 0;
  const client = new TelegramClient({ token: '123:abc', dir: f.control, sleep: async () => {}, fetchImpl: async () => {
    requests++; return { ok: false, json: async () => ({ ok: false, error_code: 429, parameters: { retry_after: 60 } }) };
  } });
  await assert.rejects(client.call('sendMessage', { chat_id: '100', text: 'x' }), /TELEGRAM_ERROR_429/);
  const restarted = new TelegramClient({ token: '123:abc', dir: f.control, sleep: async () => {}, fetchImpl: () => assert.fail('cooldown request') });
  await assert.rejects(restarted.call('getUpdates', {}, { polling: true }), /TELEGRAM_RETRY_WAIT/);
  assert.equal(requests, 1);
});

test('controlled worker downloads Story locally when every personal media notification is off', async t => {
  const f = fixture(t), s = f.settings;
  delete s.users['100'].targets.bob;
  for (const pref of Object.values(s.users['100'].targets.alice.notifications)) pref.enabled = false;
  atomic(settingsFile(f.env), s);
  const jpg = Buffer.alloc(32); jpg[0] = 255; jpg[1] = 216; jpg[2] = 255;
  t.mock.method(globalThis, 'fetch', async url => { assert.ok(String(url).startsWith('https://s.cdninstagram.com/')); return new Response(jpg, { headers: { 'content-length': '32' } }); });
  await main({ env: { ...f.env, IG_TELEGRAM_CONTROL: '1', TELEGRAM_BOT_TOKEN: '123:abc', IG_ARCHIVE_DIR: f.root, IG_CATALOG_ENABLED: '0' },
    args: ['--once'], dir: f.state, sleepImpl: async () => {}, resolve: async () => '101',
    fetcher: async (_script, _child, _timeout, env) => {
      fs.writeFileSync(env.IG_STORY_RESULT_FILE, JSON.stringify({ version: 1, targetUserId: '101', storyCount: 1, stories: [story], skippedIds: [] }));
      return { targetUserId: '101', storyCount: 1, stories: [story], guard: { blockedReadReceipt: 0 } };
    } });
  const archive = JSON.parse(fs.readFileSync(path.join(f.state, 'archive-101.json'), 'utf8'));
  assert.ok(fs.existsSync(path.join(f.root, 'instagram', 'alice', archive.saved['789'].relativePath)));
  const events = fs.readdirSync(path.join(f.state, 'telegram-events'));
  for (const file of events) f.delivery.ingest(JSON.parse(fs.readFileSync(path.join(f.state, 'telegram-events', file), 'utf8')));
  assert.equal(Object.keys(f.delivery.state.pending).length, 0);
});

test('prototype-named accounts remain own subscriptions through JSON/clone round trips and buttons', t => {
  const f = fixture(t);
  let s = f.settings, n = 1;
  for (const name of ['constructor', '__proto__', 'tostring']) {
    applyUpdate(s, message(n++, 100, '/add ' + name), 2000);
    s = structuredClone(JSON.parse(JSON.stringify(s)));
    assert.equal(Object.hasOwn(s.users['100'].targets, name), true);
    applyUpdate(s, callback(n++, 100, 'account:' + name), 2100);
    const sub = s.users['100'].targets[name];
    applyUpdate(s, callback(n++, 100, `set:${name}:post:0:${sub.generation.slice(0,8)}`), 2200);
    assert.equal(sub.notifications.post.enabled, false);
  }
  atomic(settingsFile(f.env), s);
  assert.equal(targetConfigs(readSettings(settingsFile(f.env))).some(t => t.username === '__proto__'), true);
});

test('one blocked user cannot starve another user menu replies', async t => {
  const { flushReplies } = await import('../src/telegram-replies.mjs');
  const { settings: s } = fixture(t);
  applyUpdate(s, message(1, 100, '/menu'), 2000);
  applyUpdate(s, message(2, 200, '/menu'), 2000);
  const sent = [];
  await flushReplies(s, { call: async (_method, body) => { if (body.chat_id === '100') throw Error('TELEGRAM_ERROR_403'); sent.push(body.chat_id); } }, () => {});
  assert.deepEqual(sent, ['200']); assert.equal(Object.keys(s.replies).length, 1);
  assert.ok(Object.values(s.replies)[0].retryAt > Date.now());
  await flushReplies(s, { call: () => assert.fail('failed reply must back off') }, () => {});
});

test('newly discovered historical posts/highlights stay quiet after removing and re-adding a target', t => {
  const f = fixture(t);
  delete f.settings.users['100'].targets.alice;
  f.settings.users['100'].targets.alice = subscription(5000);
  for (const kind of ['post', 'highlight']) f.delivery.ingest({ ...post(6000, kind), publishedAt: 4000 });
  assert.equal(Object.keys(f.delivery.state.pending).length, 0);
  f.delivery.ingest({ ...post(7000), publishedAt: 6500 });
  assert.equal(Object.keys(f.delivery.state.pending).length, 1);
});

test('ID-only legacy target and canonical username share one worker and route to both subscribers', async t => {
  const f = fixture(t), s = f.settings;
  s.users['100'].targets = { 101: subscription(1000) }; s.legacyIds['101'] = '101';
  s.users['200'].targets.alice = subscription(1000); atomic(settingsFile(f.env), s);
  const calls = [];
  await main({ env: { ...f.env, IG_TELEGRAM_CONTROL: '1', TELEGRAM_BOT_TOKEN: '123:abc', IG_CATALOG_ENABLED: '0' }, args: ['--once'], dir: f.state,
    resolve: async () => '101', sleepImpl: async () => {},
    fetcher: async (_script, _child, _timeout, env) => {
      calls.push(env.IG_TARGET_USERNAME);
      fs.writeFileSync(env.IG_STORY_RESULT_FILE, JSON.stringify({ version: 1, targetUserId: '101', storyCount: 1, stories: [story], skippedIds: [] }));
      return { targetUserId: '101', storyCount: 1, stories: [story], guard: { blockedReadReceipt: 0 } };
    } });
  assert.deepEqual(calls, ['alice']);
  const events = fs.readdirSync(path.join(f.state, 'telegram-events'));
  for (const file of events) f.delivery.ingest(JSON.parse(fs.readFileSync(path.join(f.state, 'telegram-events', file), 'utf8')));
  assert.deepEqual(Object.values(f.delivery.state.pending).map(t => t.userId).sort(), ['100', '200']);
});

test('watchdog fallback continues past a blocked owner and backs off all users only for 429', async t => {
  const { sendControlFallback } = await import('../src/telegram-fallback.mjs');
  const state = {}, called = [];
  const options = { recipients: ['100', '200'], state, token: '123:abc', signal: new AbortController().signal, persist: () => {}, log: () => {},
    fetchImpl: async (_url, options) => {
      const id = JSON.parse(options.body).chat_id; called.push(id);
      return { ok: id === '200', status: id === '200' ? 200 : 403, json: async () => ({ ok: id === '200', error_code: 403 }) };
    } };
  await sendControlFallback(options);
  assert.deepEqual(called, ['100', '200']); assert.equal(state.controlFallbackSent['200'], true);
  await sendControlFallback(options); assert.equal(called.length, 2, 'failed owner backs off; successful recipient is not duplicated');
  const limited = {};
  await sendControlFallback({ ...options, state: limited, fetchImpl: async () => ({ ok: false, status: 429, json: async () => ({ ok: false, error_code: 429, parameters: { retry_after: 120 } }) }) });
  assert.ok(limited.controlFallbackRetryAt > Date.now() + 100000);
});

test('alias account error/recovery metadata and summaries include both subscriptions without leaking other targets', async t => {
  const { Issues } = await import('../src/error-monitor.mjs');
  const { describeUser } = await import('../src/telegram-control.mjs');
  const f = fixture(t), s = f.settings;
  s.users['100'].targets = { 101: subscription(1000) };
  s.users['200'].targets.alice = subscription(1000);
  const outbox = path.join(f.state, 'monitor/outbox');
  const issues = new Issues(path.join(f.state, 'monitor/issues.json'), outbox, 'all');
  issues.fail('target:alice:fetch', 'FETCH_TIMEOUT', '@alice', { target: '101', usernames: ['101', 'alice'] });
  issues.fail('target:bob:fetch', 'BOB_PRIVATE_ERROR', '@bob', { target: '202', usernames: ['bob'] });
  atomic(path.join(f.state, 'health.json'), { at: Date.now(), targets: [{ username: '101', target: '101', failures: 1 }, { username: 'alice', target: '101', failures: 1 }] });
  const summary = describeUser(s, '100', f.state);
  assert.match(summary, /target:alice:fetch/); assert.doesNotMatch(summary, /BOB_PRIVATE_ERROR/);
  issues.resolve('target:alice:fetch');
  for (const file of fs.readdirSync(outbox)) {
    const event = JSON.parse(fs.readFileSync(path.join(outbox, file), 'utf8'));
    if (event.target === '101') assert.deepEqual(alertRecipients(s, event), ['100', '200']);
  }
});

test('status menu survives corrupt target history and reports the read failure', async t => {
  const { describeUser } = await import('../src/telegram-control.mjs');
  const f = fixture(t);
  atomic(path.join(f.state, 'health.json'), { at: Date.now(), targets: [{ username: 'alice', target: '101', failures: 0 }] });
  fs.writeFileSync(path.join(f.state, 'catalog-101.json'), '{');
  const result = describeUser(f.settings, '100', f.state);
  assert.match(result, /讀取失敗/);
});

test('managed settings refresh does not turn a five-minute IG interval into five-second scans', async t => {
  const f = fixture(t), s = f.settings, args = [], calls = [];
  delete s.users['100'].targets.bob; atomic(settingsFile(f.env), s);
  let waits = 0;
  await main({ env: { ...f.env, IG_TELEGRAM_CONTROL: '1', TELEGRAM_BOT_TOKEN: '123:abc', IG_CATALOG_ENABLED: '0' }, args, dir: f.state,
    resolve: async () => '101', sleepImpl: async () => { if (++waits >= 2) args.push('--once'); },
    fetcher: async (_script, _child, _timeout, env) => {
      calls.push(env.IG_TARGET_USER_ID);
      fs.writeFileSync(env.IG_STORY_RESULT_FILE, JSON.stringify({ version: 1, targetUserId: '101', storyCount: 0, stories: [], skippedIds: [] }));
      return { targetUserId: '101', storyCount: 0, stories: [], guard: { blockedReadReceipt: 0 } };
    } });
  assert.deepEqual(calls, ['101']);
});

test('adding/removing targets takes effect in the running worker without restoring the env list', async t => {
  const f = fixture(t), s = f.settings, args = [], calls = [];
  delete s.users['100'].targets.bob; atomic(settingsFile(f.env), s);
  await main({ env: { ...f.env, IG_TELEGRAM_CONTROL: '1', TELEGRAM_BOT_TOKEN: '123:abc', IG_CATALOG_ENABLED: '0' }, args, dir: f.state,
    resolve: async config => config.username === 'alice' ? '101' : '202',
    sleepImpl: async () => { delete s.users['100'].targets.alice; s.users['100'].targets.bob = subscription(2000); atomic(settingsFile(f.env), s); args.push('--once'); },
    fetcher: async (_script, _child, _timeout, env) => {
      calls.push(env.IG_TARGET_USERNAME);
      fs.writeFileSync(env.IG_STORY_RESULT_FILE, JSON.stringify({ version: 1, targetUserId: env.IG_TARGET_USER_ID, storyCount: 0, stories: [], skippedIds: [] }));
      return { targetUserId: env.IG_TARGET_USER_ID, storyCount: 0, stories: [], guard: { blockedReadReceipt: 0 } };
    } });
  assert.deepEqual(calls, ['alice', 'bob']);
  assert.ok(fs.existsSync(path.join(f.state, 'watch-media-101.json')));
});

test('complete controller persists update offsets and menus across restart using the real service loop', async t => {
  const { run } = await import('../src/telegram-control.mjs');
  const f = fixture(t), sent = [], methods = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const method = String(url).split('/').at(-1), body = JSON.parse(options.body); methods.push(method);
    let result = true;
    if (method === 'getWebhookInfo') result = { url: '' };
    if (method === 'getUpdates') result = [message(1, 200, '/add charlie'), callback(2, 200, 'daily:1'), message(3, 999, '/add evil')];
    if (method === 'sendMessage') sent.push(body);
    return { ok: true, json: async () => ({ ok: true, result }) };
  });
  const env = { ...f.env, TELEGRAM_BOT_TOKEN: '123:abc', IG_STATE_DIR: f.state, IG_WATCHDOG_DIR: path.join(f.dir, 'watchdog') };
  await run({ env, args: ['--once'] });
  let saved = readSettings(settingsFile(env));
  assert.ok(saved.users['200'].targets.charlie); assert.equal(saved.users['200'].daily, true); assert.equal(saved.offset, 4);
  const before = sent.filter(body => body.reply_markup).length;
  await run({ env, args: ['--once'] });
  saved = readSettings(settingsFile(env)); assert.equal(saved.offset, 4); assert.equal(sent.filter(body => body.reply_markup).length, before);
  assert.ok(sent.every(body => body.chat_id === '200')); assert.ok(methods.includes('answerCallbackQuery'));
});

test('watchdog fallback isolates DOMException timeouts and propagates durable-write failures', async () => {
  const { sendControlFallback } = await import('../src/telegram-fallback.mjs');
  const calls = [], state = {};
  const options = { recipients: ['100', '200'], state, token: '123:abc', signal: new AbortController().signal, persist: () => {}, log: () => {},
    fetchImpl: async (_url, options) => {
      const id = JSON.parse(options.body).chat_id; calls.push(id);
      if (id === '100') throw new DOMException('request timeout', 'TimeoutError');
      return { ok: true, json: async () => ({ ok: true }) };
    } };
  await sendControlFallback(options);
  assert.deepEqual(calls, ['100', '200']); assert.equal(state.controlFallbackSent['200'], true);
  await assert.rejects(sendControlFallback({ ...options, recipients: ['200'], state: {}, persist: () => { throw Object.assign(Error('disk'), { code: 'ENOSPC' }); } }), /disk/);
});

test('invalid JSON values in saved settings fail closed instead of resetting subscriptions', t => {
  const f = fixture(t), file = settingsFile(f.env);
  for (const invalid of ['null', 'false', '0', '[]']) {
    fs.writeFileSync(file, invalid);
    assert.throws(() => initializeSettings(f.env), /SETTINGS_INVALID/);
    assert.equal(fs.readFileSync(file, 'utf8'), invalid);
  }
});

test('removed-account incidents are suspended and aliases migrate one target scope without affecting others', async t => {
  const { Issues } = await import('../src/error-monitor.mjs');
  const f = fixture(t), file = path.join(f.dir, 'scopes.json');
  const issues = new Issues(file, path.join(f.dir, 'scope-outbox'), 'all');
  issues.fail('target:101:fetch', 'FETCH_TIMEOUT', '@101', { target: '101', usernames: ['101'] });
  issues.fail('target:bob:fetch', 'FETCH_TIMEOUT', '@bob', { target: '202', usernames: ['bob'] });
  issues.migrateTarget('101', 'alice');
  assert.equal(Object.hasOwn(issues.state, 'target:101:fetch'), false);
  assert.equal(issues.state['target:alice:fetch'].active, true);
  issues.suspendAccount('alice', '101');
  assert.equal(issues.state['target:alice:fetch'].active, false);
  assert.equal(issues.state['target:bob:fetch'].active, true);
});

test('status commands and refresh callbacks offer a fresh status button',t=>{
  const f=fixture(t);let version=0;const describe=()=>`status ${++version}`;
  applyUpdate(f.settings,message(501,100,'/status'),1000,describe);
  let body=f.settings.replies['reply:501'].body;
  assert.equal(body.text,'status 1');assert.equal(body.reply_markup.inline_keyboard[0][0].callback_data,'status');
  applyUpdate(f.settings,callback(502,100,'status'),1001,describe);
  body=f.settings.replies['reply:502'].body;assert.equal(body.text,'status 2');
  f.settings.users['100'].daily=true;
  f.delivery.daily(Date.UTC(2026,10,14,12),describe);
  const summary=Object.values(f.delivery.state.pending).find(task=>task.type==='summary');
  assert.equal(summary.body.reply_markup.inline_keyboard[0][0].callback_data,'status');
});
