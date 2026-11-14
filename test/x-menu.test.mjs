import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initializeSettings, validateSettings, settingsFile } from '../src/telegram-settings.mjs';
import { applyUpdate, mainMenu } from '../src/telegram-menu.mjs';
import { atomic } from '../src/error-monitor.mjs';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'x-menu-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = { TELEGRAM_CHAT_ID: '100', TELEGRAM_ALLOWED_USER_IDS: '200', IG_CONTROL_DIR: dir };
  return { env, settings: initializeSettings(env, 1000), dir };
}
const message = (n, id, text, type = 'private') => ({ update_id: n, message: { from: { id }, chat: { id, type }, text } });
const callback = (n, id, data) => ({ update_id: n, callback_query: { id: String(n), from: { id }, message: { chat: { id, type: 'private' } }, data } });
const reply = (s, n) => s.replies[`reply:${n}`].body;

test('X subscriptions remain private, normalize names, and preserve the IG subscription set', t => {
  const { settings: s } = fixture(t);
  applyUpdate(s, message(1, 100, '/xadd @Alice'), 2000);
  applyUpdate(s, message(2, 200, '/xadd bob'), 2100);
  assert.equal(s.users['100'].xTargets.alice.joinedAt, 2000);
  assert.deepEqual(Object.keys(s.users['100'].targets), []);
  assert.deepEqual(Object.keys(s.users['200'].xTargets), ['bob']);
  assert.deepEqual(Object.keys(s.users['100'].xTargets.alice.notifications), ['post', 'repost', 'reply', 'quote']);
  assert.ok(mainMenu(s.users['100']).reply_markup.inline_keyboard.flat().some(b => b.callback_data === 'x:menu'));
  assert.equal(validateSettings(s), s);
});

test('X settings use subscription generations and confirmation before removal', t => {
  const { settings: s } = fixture(t);
  applyUpdate(s, message(1, 100, '/xadd alice'), 2000);
  const sub = s.users['100'].xTargets.alice, gen = sub.generation.slice(0, 8);
  applyUpdate(s, callback(2, 100, `x:set:alice:reply:0:${gen}`), 2100);
  assert.equal(sub.notifications.reply.enabled, false);
  applyUpdate(s, callback(3, 100, `x:remove:alice:${gen}`), 2200);
  assert.ok(s.users['100'].xTargets.alice);
  applyUpdate(s, callback(4, 100, `x:delete:alice:${gen}`), 2300);
  assert.equal(Object.hasOwn(s.users['100'].xTargets, 'alice'), false);
  applyUpdate(s, message(5, 100, '/xadd alice'), 2400);
  applyUpdate(s, callback(6, 100, `x:delete:alice:${gen}`), 2500);
  assert.ok(s.users['100'].xTargets.alice);
  for (const entry of Object.values(s.replies)) for (const row of entry.body.reply_markup?.inline_keyboard || [])
    for (const button of row) assert.ok(Buffer.byteLength(button.callback_data) <= 64);
});

test('X backfill requests require a current personal subscription and valid optional dates', t => {
  const { settings: s } = fixture(t);
  applyUpdate(s, message(1, 100, '/xhistory alice'), 2000);
  assert.deepEqual(s.xRequests || {}, {});
  applyUpdate(s, message(2, 100, '/xadd alice'), 2100);
  applyUpdate(s, message(3, 100, '/xhistory alice'), 2200);
  assert.deepEqual(s.xRequests['100-3-0'], { id: '100-3-0', userId: '100', type: 'history', username: 'alice', at: 2200 });
  applyUpdate(s, message(4, 100, '/xhistory alice 2024-01-01 2025-01-01'), Date.parse('2026-11-13T00:00:00Z'));
  assert.equal(s.xRequests['100-4-0'].start, '2024-01-01');
  assert.equal(s.xRequests['100-4-0'].end, '2025-01-01');
  for (const [i, dates] of ['2024-02-30 2025-01-01', '2025-01-01 2024-01-01', '2024-01-01'].entries())
    applyUpdate(s, message(5 + i, 100, '/xhistory alice ' + dates), 2400);
  assert.equal(Object.keys(s.xRequests).length, 2);
  assert.equal(validateSettings(s), s);
});
test('future history ranges cannot occupy the shared worker queue', t => {
  const f=fixture(t),s=f.settings,now=Date.parse('2026-11-13T09:00:00Z');
  applyUpdate(s,message(1,100,'/xadd alice'),now);
  applyUpdate(s,message(2,100,'/xhistory alice 2006-01-01 9999-12-31'),now);
  applyUpdate(s,message(3,100,'/xhistory alice 2026-11-14 2026-11-15'),now);
  assert.equal(Object.keys(s.xRequests||{}).length,0);
  applyUpdate(s,message(4,100,'/xhistory alice 2026-11-13 2026-11-14'),now);
  assert.equal(Object.keys(s.xRequests).length,1);
});

test('private identity and whitelist protect X buttons, commands and manual downloads', t => {
  const { settings: s } = fixture(t);
  for (const update of [message(1, 999, '/xadd alice'), message(2, 100, '/xadd alice', 'group'),
    message(3, 999, 'https://x.com/alice/status/123'), callback(4, 999, 'x:follow:alice')]) applyUpdate(s, update, 2000);
  assert.deepEqual(s.users['100'].xTargets || {}, {});
  assert.deepEqual(s.xRequests || {}, {});
  assert.deepEqual(s.replies, {});
});

test('X post links queue explicit downloads while profile links require follow confirmation', t => {
  const { settings: s } = fixture(t);
  applyUpdate(s, message(1, 100, 'https://fxtwitter.com/Alice/status/123?s=20 https://twitter.com/bob'), 2000);
  const request = Object.values(s.xRequests)[0];
  assert.equal(request.type, 'manual');
  assert.equal(request.username, 'alice');
  assert.equal(request.url, 'https://x.com/alice/status/123');
  assert.deepEqual(s.users['100'].xTargets || {}, {});
  assert.ok(reply(s, 1).reply_markup.inline_keyboard.flat().some(b => b.callback_data === 'x:follow:bob'));
  applyUpdate(s, callback(2, 100, 'x:follow:bob'), 2100);
  assert.ok(s.users['100'].xTargets.bob);
});

test('mixed Instagram and X links enqueue both platforms independently', t => {
  const { settings: s } = fixture(t);
  applyUpdate(s, message(1, 100, 'https://www.instagram.com/p/ABC123/ https://x.com/alice/status/123'), 2000);
  assert.equal(Object.keys(s.manualRequests).length, 1);
  assert.equal(Object.keys(s.xRequests).length, 1);
  assert.match(reply(s, 1).text, /X/);
});

test('old settings remain compatible and X environment subscriptions import only on first initialization', t => {
  const f = fixture(t);
  assert.equal(validateSettings(f.settings), f.settings);
  const nextDir = path.join(f.dir, 'first');
  const env = { ...f.env, IG_CONTROL_DIR: nextDir, X_TARGET_USERNAMES: 'Alice,@BOB,alice' };
  const first = initializeSettings(env, 2000);
  assert.deepEqual(Object.keys(first.users['100'].xTargets), ['alice', 'bob']);
  first.users['100'].xTargets = {};
  atomic(settingsFile(env), first);
  const restarted = initializeSettings({ ...env, X_TARGET_USERNAMES: 'charlie' }, 3000);
  assert.deepEqual(Object.keys(restarted.users['100'].xTargets), []);
});

test('malformed persisted X state fails closed instead of silently losing requests', t => {
  const { settings: s } = fixture(t);
  const invalids = [
    x => { x.users['100'].xTargets = []; },
    x => { x.users['100'].xTargets = { alice: {} }; },
    x => { x.xRequests = []; },
    x => { x.xRequests = { evil: { id: 'evil', userId: '100', type: 'history', username: 'alice', at: 1 } }; },
    x => { x.xRequests = { '100-1-0': { id: '100-1-0', userId: '200', type: 'history', username: 'alice', at: 1 } }; },
    x => { x.xRequests = { '100-1-0': { id: '100-1-0', userId: '100', type: 'manual', username: 'bob', url: 'https://x.com/alice/status/123', at: 1 } }; },
    x => { x.xRequests = { '100-1-0': { id: '100-1-0', userId: '100', type: 'history', username: 'alice', start: '2024-02-30', at: 1 } }; },
  ];
  for (const mutate of invalids) {
    const invalid = structuredClone(s); mutate(invalid);
    assert.throws(() => validateSettings(invalid), /TELEGRAM_SETTINGS_INVALID/);
  }
});

test('prototype-looking X names are treated as own entries through settings round trips', t => {
  let { settings: s } = fixture(t);
  let n = 1;
  for (const name of ['constructor', '__proto__', 'tostring']) {
    applyUpdate(s, message(n++, 100, '/xadd ' + name), 2000);
    s = JSON.parse(JSON.stringify(s));
    assert.equal(Object.hasOwn(s.users['100'].xTargets, name), true);
    assert.equal(validateSettings(s), s);
  }
});

test('mixed-platform messages enforce a shared limit without queueing partial overflow', t => {
  const { settings: s } = fixture(t);
  const links = [
    ...Array.from({ length: 6 }, (_, i) => `https://www.instagram.com/p/ABC${i}/`),
    ...Array.from({ length: 5 }, (_, i) => `https://x.com/alice/status/${i + 1}`),
  ];
  applyUpdate(s, message(1, 100, links.join(' ')), 2000);
  assert.equal(Object.keys(s.manualRequests || {}).length, 0);
  assert.equal(Object.keys(s.xRequests || {}).length, 0);
  assert.match(reply(s, 1).text, /10/);
});

test('unsupported X links do not discard valid links in the same message', t => {
  const { settings: s } = fixture(t);
  applyUpdate(s, message(1, 100, 'https://x.com/alice/status/123 https://x.com/search?q=foo'), 2000);
  assert.equal(Object.values(s.xRequests).length, 1);
  assert.match(reply(s, 1).text, /不支援/);
});

test('X status scopes targets and jobs to each user and reports unavailable progress safely', async t => {
  const { describeUser } = await import('../src/telegram-control.mjs');
  const f = fixture(t), s = f.settings, state = path.join(f.dir, 'state');
  applyUpdate(s, message(1, 100, '/xadd alice'), 2000);
  applyUpdate(s, message(2, 200, '/xadd bob'), 2000);
  applyUpdate(s, message(3, 100, '/xhistory alice'), 2100);
  applyUpdate(s, message(4, 200, '/xhistory bob'), 2100);
  atomic(path.join(state, 'x/health.json'), { at: Date.now(), targets: [{ username: 'alice', saved: 8, pending: 2 }, { username: 'bob', saved: 77 }], pool: { active: 2, locked: 1 } });
  atomic(path.join(state, 'x/jobs/100-3-0.json'), { status: 'working', reason: 'X_NO_ACCOUNT_AVAILABLE', posts: 5, phase: 'search', progress: { completedWindows: 4, partialWindows: 1, failedWindows: 0 } });
  atomic(path.join(state, 'x/jobs/200-4-0.json'), { status: 'failed', reason: 'BOB_PRIVATE_ERROR' });
  const text = describeUser(s, '100', state);
  assert.match(text, /@alice · 正常/); assert.match(text, /待下載：2/); assert.doesNotMatch(text, /回補帳號池|已封存/);
  assert.match(text, /進度：搜尋歷史貼文/); assert.match(text, /預計完成：暫時無法估算/);
  assert.doesNotMatch(text, /X_NO_ACCOUNT_AVAILABLE/, 'old retry reasons are not current failures while work is running');
  assert.doesNotMatch(text, /bob|BOB_PRIVATE_ERROR/);
  atomic(path.join(state, 'x/jobs/100-3-0.json'), { status: 'retry', reason: 'X_NO_ACCOUNT_AVAILABLE', retryAt: Date.parse('2026-11-12T18:18:01Z'), posts: 5 });
  assert.match(describeUser(s, '100', state), /等待重試/);
  assert.doesNotMatch(describeUser(s, '100', state), /下次嘗試|X_NO_ACCOUNT_AVAILABLE/);
  fs.writeFileSync(path.join(state, 'x/jobs/100-3-0.json'), '{');
  assert.match(describeUser(s, '100', state), /讀取失敗/);
});

test('X menu waiting, list paging and expired buttons remain isolated from IG actions', t => {
  const { settings: s } = fixture(t);
  applyUpdate(s, callback(1, 100, 'x:add'), 2000);
  assert.equal(s.users['100'].waiting, 'x:add');
  applyUpdate(s, message(2, 100, 'bad.name'), 2100);
  assert.equal(s.users['100'].waiting, 'x:add');
  applyUpdate(s, message(3, 100, 'alice'), 2200);
  assert.equal(s.users['100'].waiting, undefined);
  assert.ok(s.users['100'].xTargets.alice);
  for (let i = 0; i < 9; i++) applyUpdate(s, message(4 + i, 100, '/xadd user' + i), 2300);
  applyUpdate(s, callback(13, 100, 'x:list:1'), 2400);
  assert.match(reply(s, 13).text, /2\/2/);
  applyUpdate(s, callback(14, 100, 'x:history:alice:wrong'), 2500);
  assert.match(reply(s, 14).text, /過期/);
  applyUpdate(s, callback(15, 100, 'x:download'), 2600);
  assert.match(reply(s, 15).text, /fxtwitter/);
  applyUpdate(s, callback(16, 100, 'x:add'), 2700);
  applyUpdate(s, message(17, 100, '/cancel'), 2800);
  assert.equal(s.users['100'].waiting, undefined);
});
