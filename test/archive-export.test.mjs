import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyUpdate } from '../src/telegram-menu.mjs';
import { exportCallback, exportGeneration, ingestExportReports, validateExportSettings } from '../src/archive-export.mjs';
import { flushReplies } from '../src/telegram-replies.mjs';

const settings = () => ({ version: 1, ownerId: '1', allowedIds: ['1', '2'], offset: 0, replies: {}, users: { '1': { daily: false, targets: {} }, '2': { daily: false, targets: {}, xTargets: { alice: { generation: 'gen-1' } } } } });
const callback = (data, id = 1, uid = 2) => ({ update_id: id, callback_query: { id: 'callback', from: { id: uid }, data, message: { chat: { id: uid, type: 'private' } } } });

test('only current subscribers or owner can request exports; confirmation is durable', () => {
  const s = settings();
  applyUpdate(s, callback('ex:preview:x:bob'), Date.now(), undefined, true);
  assert.equal(s.exportRequests, undefined);
  applyUpdate(s, callback('ex:preview:x:alice', 2), Date.now(), undefined, true);
  assert.equal(s.exportRequests['2-2'].action, 'preview');
  assert.equal(s.exportRequests['2-2'].name, 'alice');
  assert.equal(exportGeneration(s, '1', 'x', 'bob'), 'owner');
  validateExportSettings(JSON.parse(JSON.stringify(s)));
  s.users['2'].xTargets = {};
  assert.equal(exportGeneration(s, '2', 'x', 'alice'), undefined);
  applyUpdate(s, callback('ex:preview:x:alice', 3), Date.now(), undefined, true);
  assert.equal(s.exportRequests['2-3'], undefined);
});

test('disabled export service does not enqueue commands and pending commands are bounded', () => {
  const s = settings();
  assert.match(exportCallback(s, '2', 'ex:preview:x:alice', 1, 0, false).text, /尚未啟用/);
  for (let i = 0; i < 20; i++) exportCallback(s, '2', 'ex:preview:x:alice', i, 0, true);
  assert.equal(Object.keys(s.exportRequests).length, 8);
});

test('reports and update removal are acknowledged in one controller state; stale links are not sent', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-export-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const s = settings(), key = 'a'.repeat(24);
  const grant = { platform: 'x', name: 'alice', generation: 'gen-1', expires: Date.now() / 1000 + 60 };
  s.exportRequests = { '2-1': { id: '2-1' } };
  fs.writeFileSync(path.join(dir, 'health.json'), JSON.stringify({ at: Date.now() }));
  fs.writeFileSync(path.join(dir, 'reports.json'), JSON.stringify({ [key]: { userId: '2', text: 'download', rows: [], requestId: '2-1', grant } }));
  assert.equal(ingestExportReports(s, dir), true);
  assert.equal(s.exportRequests['2-1'], undefined);
  assert.ok(s.exportReceipts[key]);
  ingestExportReports(s, dir);
  assert.equal(Object.keys(s.replies).length, 1);
  s.users['2'].xTargets.alice.generation = 'new-generation';
  let calls = 0;
  await flushReplies(s, { call: async () => { calls++; } }, () => {});
  assert.equal(calls, 0);
  assert.equal(Object.keys(s.replies).length, 0);
});

test('private-chat and allowlist restrictions also protect export callback routing', () => {
  const s = settings();
  const update = callback('ex:preview:x:alice');
  update.callback_query.message.chat.type = 'group';
  applyUpdate(s, update, Date.now(), undefined, true);
  assert.equal(s.exportRequests, undefined);
  for (const platform of ['constructor', '__proto__', 'toString']) {
    assert.doesNotThrow(() => exportCallback(s, '2', `ex:preview:${platform}:alice`, 1, 0, true));
    assert.equal(s.exportRequests, undefined);
  }
});
