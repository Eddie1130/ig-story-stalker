import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyUpdate } from '../src/telegram-menu.mjs';
import { exportCallback, exportGeneration, exportAccountNames, ingestExportReports, validateExportSettings } from '../src/archive-export.mjs';
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

test('platform selection immediately returns the account list without a queued request or holding message', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-accounts-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'x', 'archived'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'x', 'manual'));
  const s = settings();
  const accounts = p => exportAccountNames(s, p, { root: dir });
  applyUpdate(s, callback('ex:owner:x:0', 1, 1), Date.now(), undefined, true, accounts);
  assert.equal(s.exportRequests, undefined);
  const reply = s.replies['reply:1'].body;
  assert.equal(reply.text, '管理員：選擇要匯出的帳號');
  assert.deepEqual(reply.reply_markup.inline_keyboard.flat().map(b => b.text), ['@alice', '@archived', '⬅️ 主選單']);
  assert.ok(!JSON.stringify(s.replies).includes('正在處理匯出操作'));
  applyUpdate(s, callback('ex:owner:x:0', 2, 2), Date.now(), undefined, true, accounts);
  assert.match(s.replies['reply:2'].body.text, /沒有.*權限/);
});

test('reply receipts and retries update the newest settings if polling replaced state during a send', async () => {
  for (const failure of [false, true]) {
    let current = settings();
    current.replies.one = { method: 'sendMessage', userId: '2', body: { chat_id: '2', text: 'reply' } };
    await flushReplies(() => current, { call: async () => {
      current = structuredClone(current);
      current.replies.two = { method: 'sendMessage', userId: '2', body: { chat_id: '2', text: 'next' } };
      if (failure) throw Error('TELEGRAM_NETWORK_OR_RESPONSE_ERROR');
    } }, () => {});
    assert.ok(current.replies.two);
    if (failure) assert.equal(current.replies.one.failures, 1);
    else assert.equal(current.replies.one, undefined);
  }
});
