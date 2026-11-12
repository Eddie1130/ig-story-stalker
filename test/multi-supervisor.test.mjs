import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import readline from 'node:readline';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { Issues, atomic, load, safe, eventIssue } from '../src/error-monitor.mjs';
import { targetIssueKey } from '../src/targets.mjs';

test('real supervisor clears persistent session/runtime/legacy issues after worker restart and scopes recovery', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ig-supervisor-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const monitor = path.join(dir, 'monitor'), file = path.join(monitor, 'issues.json');
  const issues = new Issues(file, path.join(monitor, 'outbox'), '@alice');
  issues.fail('shared-session', 'SESSION_INVALID_RELOGIN_REQUIRED');
  issues.fail('target:alice:target-runtime', 'INVALID_MEDIA_STATE');
  issues.fail('target:bob:target-runtime', 'INVALID_MEDIA_STATE');
  issues.fail('fetch', 'FETCH_TIMEOUT');
  fs.writeFileSync(path.join(dir, 'watch-media-101.json'), '{}');
  const processMock = new EventEmitter();
  processMock.env = { IG_MONITOR_DIR: monitor, IG_TARGET_USERNAMES: 'alice,bob' };
  processMock.kill = () => {}; processMock.exit = () => assert.fail('supervisor must not exit fatally');
  const source = fs.readFileSync(new URL('../src/watch-supervisor.mjs', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '');
  const spawn = () => {
    const worker = new EventEmitter(); worker.pid = 123;
    worker.stdout = new PassThrough(); worker.stderr = new PassThrough();
    setImmediate(() => {
      // The fresh worker has no knowledge of the prior invalid session/runtime error.
      for (const row of [
        { event: 'WATCH_TARGET_READY', target: '101', username: 'alice' },
        { event: 'WATCH_MEDIA_CHECK_OK', target: '101', username: 'alice', skippedCount: 0, skippedIds: [], mediaIds: [], storyCount: 0 },
        { event: 'WATCH_TARGET_COMPLETED', target: '101', username: 'alice' },
      ]) worker.stdout.write(JSON.stringify(row) + '\n');
      worker.stdout.end(); worker.stderr.end();
      processMock.emit('SIGTERM'); worker.emit('close', 0, null);
    });
    return worker;
  };
  const sandbox = vm.createContext({ fs, path, readline, spawn, Issues, atomic, load, safe, eventIssue, targetIssueKey,
    log: () => {}, console: { log: () => {} }, process: processMock, setInterval, clearInterval, setTimeout });
  await vm.runInContext(source, sandbox);
  const state = load(file);
  assert.equal(state['shared-session'].active, false);
  assert.equal(state['target:alice:target-runtime'].active, false);
  assert.equal(state['target:bob:target-runtime'].active, true, 'Alice recovery cannot clear Bob runtime issue');
  assert.equal(state['target:alice:fetch'].active, false);
  assert.equal(Object.hasOwn(state, 'fetch'), false);
});
