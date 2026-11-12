import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configuredTargets, resolveTarget, sessionInvalid, aggregateHealth, targetIssueKey } from '../src/targets.mjs';
import { main } from '../src/watch-media.mjs';
import { accountArchiveRoot } from '../src/archive-layout.mjs';
import { CatalogWatcher } from '../src/catalog-watch.mjs';
import { Issues, eventIssue } from '../src/error-monitor.mjs';

const fixture = t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ig-multi-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'downloads'), state = path.join(dir, 'state');
  fs.mkdirSync(root); fs.mkdirSync(state);
  return { dir, root, state };
};
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const env = { IG_TARGET_USERNAMES: 'alice,bob', TELEGRAM_BOT_TOKEN: '123:abc', TELEGRAM_CHAT_ID: '456', IG_CATALOG_ENABLED: '0' };
const media = { id: '789', mediaType: 1, mediaUrl: 'https://s.cdninstagram.com/photo.jpg', takenAt: 1700000000, expiringAt: null };
function fakeFetch(calls, failure) {
  return async (_script, _onChild, _timeout, childEnv) => {
    calls.push(childEnv.IG_TARGET_USER_ID);
    if (failure?.(childEnv)) throw Error(failure(childEnv));
    const stories = [{ ...media, username: childEnv.IG_TARGET_USERNAME }];
    fs.writeFileSync(childEnv.IG_STORY_RESULT_FILE, JSON.stringify({ version: 1, targetUserId: childEnv.IG_TARGET_USER_ID, storyCount: 1, stories, skippedIds: [] }));
    return { targetUserId: childEnv.IG_TARGET_USER_ID, storyCount: 1, stories, guard: { blockedReadReceipt: 0 } };
  };
}
const resolve = async config => config.username === 'alice' ? '101' : '202';

// These tests run the real worker orchestration with only network/browser boundaries replaced.
test('two targets deliver labelled media and keep deduplication independent across restart', async t => {
  const f = fixture(t), calls = [], sent = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => { sent.push(JSON.parse(options.body)); return { ok: true, json: async () => ({ ok: true }) }; });
  const options = { env, args: ['--once'], dir: f.state, resolve, fetcher: fakeFetch(calls), sleepImpl: async () => {} };
  await main(options);
  assert.deepEqual(calls, ['101', '202']);
  assert.deepEqual(sent.map(s => s.caption.split('\n')[0]), ['@alice', '@bob']);
  for (const id of ['101', '202']) assert.ok(read(path.join(f.state, `watch-media-${id}.json`)).sent['789']);
  assert.equal(read(path.join(f.state, 'health.json')).targets.length, 2);
  await main(options);
  assert.equal(sent.length, 2, 'restart must retain sent records for both accounts');
});

test('one target fetch failure does not suppress the other target', async t => {
  const f = fixture(t), calls = [], sent = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => { sent.push(JSON.parse(options.body)); return { ok: true, json: async () => ({ ok: true }) }; });
  await main({ env, args: ['--once'], dir: f.state, resolve, fetcher: fakeFetch(calls, e => e.IG_TARGET_USER_ID === '101' ? 'STORY_HTTP_ERROR:http=404:exit=6' : null), sleepImpl: async () => {} });
  assert.deepEqual(calls, ['101', '202']);
  assert.equal(sent[0].caption.split('\n')[0], '@bob');
  const h = read(path.join(f.state, 'health.json'));
  assert.equal(h.failures, 1); assert.equal(h.targets[1].failures, 0);
  process.exitCode = 0;
});

test('lookup failure leaves another account working; each lookup uses an isolated environment', async t => {
  const f = fixture(t), calls = [];
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => ({ ok: true }) }));
  await main({ env, args: ['--once'], dir: f.state, resolve: async c => { if (c.username === 'alice') throw Error('TARGET_LOOKUP_HTTP_404'); return '202'; }, fetcher: fakeFetch(calls), sleepImpl: async () => {} });
  assert.deepEqual(calls, ['202']);
  process.exitCode = 0;
  const original = { IG_TARGET_USERNAME: 'legacy', IG_TARGET_USER_ID: '999' };
  await resolveTarget({ username: 'alice' }, original, () => {}, async isolated => {
    assert.equal(isolated.IG_TARGET_USER_ID, ''); isolated.IG_TARGET_USER_ID = '101'; return '101';
  });
  assert.equal(original.IG_TARGET_USER_ID, '999');
});

test('shared session failure stops remaining accounts and marks health unhealthy', async t => {
  const f = fixture(t), calls = [];
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => ({ ok: true }) }));
  await main({ env, args: ['--once'], dir: f.state, resolve, fetcher: fakeFetch(calls, () => 'SESSION_INVALID:http=200:exit=2'), sleepImpl: async () => {} });
  assert.deepEqual(calls, ['101']);
  const h = read(path.join(f.state, 'health.json'));
  assert.equal(h.sessionOk, false); assert.equal(h.failures, 3);
  process.exitCode = 0;
});

test('Telegram-only test skips Instagram resolution with multiple targets', async t => {
  const f = fixture(t);
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => ({ ok: true }) }));
  await main({ env, args: ['--test-telegram'], dir: f.state, resolve: () => assert.fail('lookup must not run'), sleepImpl: async () => {} });
  assert.equal(fs.readdirSync(f.state).length, 0);
});

test('configuration precedence, validation, normalization and backwards compatibility', () => {
  assert.deepEqual(configuredTargets({ IG_TARGET_USERNAMES: 'Alice, bob,ALICE', IG_TARGET_USER_ID: '999' }), [{ username: 'alice' }, { username: 'bob' }]);
  assert.deepEqual(configuredTargets({ IG_TARGET_USERNAME: 'Alice', IG_TARGET_USER_ID: '101' }), [{ username: 'alice', target: '101' }]);
  assert.deepEqual(configuredTargets({ IG_TARGET_USER_ID: '101' }), [{ username: '101', target: '101' }]);
  for (const names of [',', 'alice,', '../escape', '.', '..', 'a/b', 'alice,bad name']) assert.throws(() => configuredTargets({ IG_TARGET_USERNAMES: names }), /TARGET_CONFIG_ERROR/);
  assert.equal(sessionInvalid(Error('SESSION_INVALID:http=200:exit=2')), true);
  assert.equal(sessionInvalid(Error('CATALOG_SESSION_INVALID')), true);
  assert.equal(sessionInvalid(Error('TARGET_BOOTSTRAP_HTTP_429')), false);
});

test('legacy directories migrate once and preserve records and per-account paths', t => {
  const f = fixture(t);
  for (const group of ['stories', 'posts', 'highlight']) { fs.mkdirSync(path.join(f.root, group)); fs.writeFileSync(path.join(f.root, group, 'old.txt'), group); }
  const stateFile = path.join(f.state, 'archive-101.json'); fs.writeFileSync(stateFile, '{"target":"101"}');
  const alice = accountArchiveRoot(f.root, f.state, '101', 'alice');
  const bob = accountArchiveRoot(f.root, f.state, '202', 'bob');
  assert.equal(alice, path.join(f.root, 'alice')); assert.equal(bob, path.join(f.root, 'bob'));
  assert.equal(fs.readFileSync(path.join(alice, 'stories/old.txt'), 'utf8'), 'stories');
  assert.equal(fs.existsSync(path.join(bob, 'stories/old.txt')), false);
  assert.equal(fs.readFileSync(stateFile, 'utf8'), '{"target":"101"}');
  assert.equal(accountArchiveRoot(f.root, f.state, '101', 'renamed'), alice, 'numeric identity keeps a stable archive root');
  fs.unlinkSync(path.join(f.state, 'archive-layout.json'));
  assert.throws(() => accountArchiveRoot(f.root, f.state, '101', 'alice'), /HISTORY_MISSING/);
});

test('interrupted migration resumes without overwriting or reassigning files', t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.root, 'alice')); fs.mkdirSync(path.join(f.root, 'alice/stories')); fs.mkdirSync(path.join(f.root, 'posts'));
  fs.writeFileSync(path.join(f.state, 'archive-layout.json'), JSON.stringify({ version: 1, accounts: { 101: 'alice' }, legacyChecked: true, migration: { owner: '101', groups: ['stories', 'posts'] } }));
  accountArchiveRoot(f.root, f.state, '101', 'alice');
  assert.equal(fs.existsSync(path.join(f.root, 'alice/posts')), true);
  assert.equal(read(path.join(f.state, 'archive-layout.json')).migration, null);
});

test('migration refuses unknown owners, conflicting destinations and symlink roots', t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.root, 'stories'));
  assert.throws(() => accountArchiveRoot(f.root, f.state, '101', 'alice'), /OWNER_AMBIGUOUS/);
  fs.writeFileSync(path.join(f.state, 'archive-101.json'), '{}');
  fs.mkdirSync(path.join(f.root, 'alice')); fs.mkdirSync(path.join(f.root, 'alice/stories'));
  assert.throws(() => accountArchiveRoot(f.root, f.state, '101', 'alice'), /DESTINATION_EXISTS/);
  fs.symlinkSync(f.root, path.join(f.dir, 'linked'));
  assert.throws(() => accountArchiveRoot(path.join(f.dir, 'linked'), f.state, '101', 'alice'), /UNSAFE_DIRECTORY/);
  assert.equal(fs.existsSync(path.join(f.root, 'stories')), true);
});

test('catalog session failure escapes so the worker pauses all targets', async t => {
  const f = fixture(t);
  const catalog = new CatalogWatcher({ root: f.root, stateDir: f.state, target: '101', username: 'alice', log: () => {}, fetcher: async () => { throw Error('CATALOG_SESSION_INVALID'); } });
  await assert.rejects(catalog.check(new AbortController().signal), /SHARED_SESSION_INVALID/);
});

test('health and alert recovery remain isolated per target', t => {
  const f = fixture(t), outbox = path.join(f.dir, 'outbox');
  const issues = new Issues(path.join(f.dir, 'issues.json'), outbox, 'all');
  const alice = { target: '101', username: 'alice' }, bob = { target: '202', username: 'bob' };
  issues.fail(targetIssueKey(alice, 'fetch'), 'FAILED', '@alice');
  issues.fail(targetIssueKey(bob, 'fetch'), 'FAILED', '@bob');
  issues.resolve(targetIssueKey(bob, 'fetch'));
  assert.equal(issues.activeCount(), 1);
  const alerts = fs.readdirSync(outbox).map(name => read(path.join(outbox, name)).text);
  assert.ok(alerts.some(text => text.includes('已解除：@bob')));
  assert.deepEqual(eventIssue({ event: 'SHARED_SESSION_INVALID' }), ['shared-session', 'SESSION_INVALID_RELOGIN_REQUIRED']);
  assert.equal(aggregateHealth([{ status: () => ({ failures: 0, nextFetchAt: 1, telegramOk: true, archiveOk: true, catalogOk: true }) }, { status: () => ({ failures: 2, nextFetchAt: 2, telegramOk: false, archiveOk: true, catalogOk: true }) }]).telegramOk, false);
});

test('a corrupt account history pauses only that account and is never overwritten', async t => {
  const f = fixture(t), calls = [];
  const broken = path.join(f.state, 'watch-media-101.json'); fs.writeFileSync(broken, '{');
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => ({ ok: true }) }));
  await main({ env, args: ['--once'], dir: f.state, resolve, fetcher: fakeFetch(calls), sleepImpl: async () => {} });
  assert.deepEqual(calls, ['202']); assert.equal(fs.readFileSync(broken, 'utf8'), '{');
  const h = read(path.join(f.state, 'health.json'));
  assert.equal(h.targets[0].failures, 3); assert.equal(h.targets[1].failures, 0);
  process.exitCode = 0;
});

test('shared session alerts retry after an initial Telegram failure while login remains invalid', async t => {
  const f = fixture(t), calls = [], args = [];
  let sends = 0, probes = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    sends++;
    if (sends === 1) throw Error('offline');
    args.push('--once');
    return { ok: true, json: async () => ({ ok: true }) };
  });
  await main({ env, args, dir: f.state, resolve, fetcher: fakeFetch(calls, () => 'SESSION_INVALID:http=200:exit=2'),
    checkSession: async () => { probes++; throw Error('TARGET_SESSION_INVALID'); }, sleepImpl: async () => {} });
  assert.equal(sends, 2); assert.equal(probes, 1); assert.deepEqual(calls, ['101']);
  process.exitCode = 0;
});

test('shared login recovery resumes all accounts without overlapping browser work', async t => {
  const f = fixture(t), calls = [], args = [], sent = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => { sent.push(JSON.parse(options.body)); return { ok: true, json: async () => ({ ok: true }) }; });
  const successfulFetch = fakeFetch(calls);
  let first = true;
  await main({ env, args, dir: f.state, resolve, sleepImpl: async () => {},
    checkSession: async () => { args.push('--once'); },
    fetcher: async (...params) => { if (first) { first = false; calls.push(params[3].IG_TARGET_USER_ID); throw Error('SESSION_INVALID:exit=2'); } return successfulFetch(...params); },
  });
  assert.deepEqual(calls, ['101', '101', '202']);
  assert.ok(sent.some(s => s.text?.includes('共用登入已恢復')));
  assert.equal(read(path.join(f.state, 'health.json')).sessionOk, true);
});

test('old account second in the new list keeps its username folder and saved history', async t => {
  const f = fixture(t), calls = [];
  fs.mkdirSync(path.join(f.root, 'stories')); fs.writeFileSync(path.join(f.root, 'stories/old.jpg'), 'preserved-media');
  fs.writeFileSync(path.join(f.state, 'archive-202.json'), JSON.stringify({ version: 1, target: '202', pending: {}, failed: {}, saved: { 789: { relativePath: 'stories/old.jpg', bytes: 15, at: 1 } } }));
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => ({ ok: true }) }));
  // Empty Story results avoid changing the pre-existing saved history.
  const fetcher = async (_script, _child, _timeout, childEnv) => {
    calls.push(childEnv.IG_TARGET_USER_ID);
    fs.writeFileSync(childEnv.IG_STORY_RESULT_FILE, JSON.stringify({ version: 1, targetUserId: childEnv.IG_TARGET_USER_ID, storyCount: 0, stories: [], skippedIds: [] }));
    return { targetUserId: childEnv.IG_TARGET_USER_ID, storyCount: 0, stories: [], guard: { blockedReadReceipt: 0 } };
  };
  await main({ env: { ...env, IG_ARCHIVE_DIR: f.root }, args: ['--once'], dir: f.state, resolve, fetcher, sleepImpl: async () => {} });
  assert.deepEqual(calls, ['101', '202']);
  assert.equal(fs.readFileSync(path.join(f.root, 'bob/stories/old.jpg'), 'utf8'), 'preserved-media');
  assert.equal(read(path.join(f.state, 'archive-202.json')).saved['789'].relativePath, 'stories/old.jpg');
  assert.equal(read(path.join(f.state, 'archive-layout.json')).accounts['202'], 'bob');
});

test('migration rejects account folder collisions including numeric usernames and corrupt mappings', t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.root, 'stories')); fs.writeFileSync(path.join(f.state, 'archive-101.json'), '{}');
  assert.throws(() => accountArchiveRoot(f.root, f.state, '202', '101'), /ACCOUNT_COLLISION/);
  assert.equal(fs.existsSync(path.join(f.root, 'stories')), true);
  fs.writeFileSync(path.join(f.state, 'archive-layout.json'), JSON.stringify({ version: 1, accounts: { 101: 'alice', 202: 'alice' }, legacyChecked: true, migration: null }));
  assert.throws(() => accountArchiveRoot(f.root, f.state, '101', 'alice'), /ACCOUNT_COLLISION/);
});

test('legacy supervisor issues migrate to the old account and resolve after restart', t => {
  const f = fixture(t), file = path.join(f.dir, 'issues.json'), outbox = path.join(f.dir, 'outbox');
  const issues = new Issues(file, outbox, '@alice');
  issues.fail('fetch', 'FETCH_TIMEOUT'); issues.fail('nas-storage', 'NAS_ENOSPC'); issues.fail('worker-stall', 'STALLED');
  issues.migrateAccount('alice');
  const restarted = new Issues(file, outbox, 'all');
  restarted.resolve(targetIssueKey({ username: 'bob' }, 'fetch'));
  assert.equal(restarted.activeCount(), 3);
  restarted.resolve(targetIssueKey({ username: 'alice' }, 'fetch'));
  restarted.resolve(targetIssueKey({ username: 'alice' }, 'nas-storage'));
  restarted.resolve('worker-stall');
  assert.equal(restarted.activeCount(), 0);
  assert.equal(Object.hasOwn(restarted.state, 'fetch'), false);
});

test('two catalogs can use identical sequence folders without sharing captions or media', async t => {
  const f = fixture(t), catalogs = [];
  for (const [target, username] of [['101', 'alice'], ['202', 'bob']]) {
    const root = accountArchiveRoot(f.root, f.state, target, username);
    const catalog = new CatalogWatcher({ root, stateDir: f.state, target, username, log: () => {}, downloader: async (dir, base) => {
      fs.mkdirSync(path.dirname(path.join(dir, base)), { recursive: true });
      fs.writeFileSync(path.join(dir, base + '.jpg'), username);
      return { relativePath: base + '.jpg', bytes: 12 };
    } });
    catalog.ingest({ kind: 'posts', cursor: null }, { version: 1, target, guard: { allowedQuery: 1, blockedReadReceipt: 0 }, kind: 'posts', posts: [{ id: '1', takenAt: 1700000000, caption: username, code: 'ABC', media: [media] }], hasNext: false, nextCursor: null });
    catalog.persist();
    await catalog.deliver(new AbortController().signal, () => assert.fail('baseline must be quiet'));
    catalogs.push(catalog);
  }
  const folder = catalogs[0].state.posts.records['1'].folder;
  assert.equal(folder, catalogs[1].state.posts.records['1'].folder);
  for (const c of catalogs) assert.equal(fs.readFileSync(path.join(c.root, folder, 'caption.txt'), 'utf8'), c.username);
});

test('Story and catalog child processes receive explicit per-account environments', async t => {
  const f = fixture(t);
  const { fetchStories } = await import('../src/watch-story.mjs');
  const { fetchCatalog } = await import('../src/catalog-watch.mjs');
  const script = path.join(f.dir, 'child.mjs');
  fs.writeFileSync(script, `
    import fs from 'node:fs';
    const target = process.env.IG_TARGET_USER_ID;
    if (process.env.IG_CATALOG_RESULT_FILE) {
      fs.writeFileSync(process.env.IG_CATALOG_RESULT_FILE, JSON.stringify({ target, username: process.env.IG_TARGET_USERNAME, plan: JSON.parse(process.env.IG_CATALOG_PLAN) }));
      console.log(JSON.stringify({ event: 'CATALOG_FETCH_SUCCESS' }));
    } else console.log(JSON.stringify({ event: 'STORY_FETCH_SUCCESS', targetUserId: target, username: process.env.IG_TARGET_USERNAME }));
  `);
  const [alice, bob] = await Promise.all([
    fetchStories(script, () => {}, 3000, { IG_TARGET_USER_ID: '101', IG_TARGET_USERNAME: 'alice' }),
    fetchStories(script, () => {}, 3000, { IG_TARGET_USER_ID: '202', IG_TARGET_USERNAME: 'bob' }),
  ]);
  assert.equal(alice.targetUserId, '101'); assert.equal(bob.username, 'bob');
  const catalog = await fetchCatalog({ kind: 'posts' }, { script, env: { IG_TARGET_USER_ID: '202', IG_TARGET_USERNAME: 'bob' } });
  assert.equal(catalog.target, '202'); assert.deepEqual(catalog.plan, { kind: 'posts' });
  fs.writeFileSync(script, `console.log(JSON.stringify({event:'SESSION_INVALID',status:200})); console.log(JSON.stringify({event:'STORY_FETCH_FATAL'})); process.exitCode=2;`);
  await assert.rejects(fetchStories(script, () => {}, 3000, {}), /SESSION_INVALID:http=200:exit=2/);
});

test('Telegram rate limits apply to every account and survive a worker restart', async t => {
  const f = fixture(t), calls = [];
  let attempts = 0;
  t.mock.method(globalThis, 'fetch', async () => { attempts++; return { ok: false, json: async () => ({ ok: false, error_code: 429, parameters: { retry_after: 60 } }) }; });
  const options = { env, args: ['--once'], dir: f.state, resolve, fetcher: fakeFetch(calls), sleepImpl: async () => {} };
  await main(options);
  assert.equal(attempts, 1, 'second account must respect the first account rate limit');
  assert.ok(read(path.join(f.state, 'telegram-rate.json')).retryAt > Date.now());
  await main(options);
  assert.equal(attempts, 1, 'a fresh worker must retain the shared cooldown');
  process.exitCode = 0;
});
