import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { formatXHistory, compactXHistory } from '../src/x-status.mjs';
import { describeUser } from '../src/telegram-control.mjs';
import { atomic } from '../src/error-monitor.mjs';

const now = Date.parse('2026-11-13T10:00:00Z');
const job = extra => ({ username: 'alice', status: 'working', phase: 'search', posts: 120, start: '2020-01-01', end: '2026-11-14',
  progressUpdatedAt: now, progress: { completedWindows: 4, totalWindows: 10, remainingWindows: 6, partialWindows: 0, failedWindows: 0,
    currentPass: 'search_replies', windowStart: '2023-01-01', windowEnd: '2023-01-08', passes: [
      { name: 'search_main', total: 4, completed: 2, partial: 0, failed: 0 }, { name: 'search_replies', total: 2, completed: 1, partial: 0, failed: 0 },
      { name: 'search_media', total: 2, completed: 1, partial: 0, failed: 0 }, { name: 'search_verify', total: 2, completed: 0, partial: 0, failed: 0 },
    ] }, ...extra });

test('search status separates metadata, window coverage, active pass, range and not-started media', () => {
  const text = formatXHistory(job(), now);
  assert.match(text, /^歷史回補 @alice：執行中；貼文資料 120 篇；完成視窗 4\/10（40%），剩餘 6/m);
  assert.match(text, /目前：回覆補抓/);
  assert.match(text, /2020-01-01.*2026-11-14.*UTC.*不含/);
  assert.match(text, /主搜尋 2\/4.*回覆 1\/2.*媒體 1\/2.*交叉驗證 0\/2/);
  assert.match(text, /目前視窗：2023-01-01.*2023-01-08/);
  assert.match(text, /本機封存：媒體下載尚未開始/);
  assert.match(text, /更新：香港時間.*18:00:00/);
  assert.doesNotMatch(text, /預計完成|ETA|已下載 120/);
  assert.ok(text.length <= 750);
});

test('partial or failed windows can never be represented as complete coverage', () => {
  for (const extra of [{ progress: { completedWindows: 10, totalWindows: 10, partialWindows: 1, failedWindows: 0 } },
    { progress: { completedWindows: 12, totalWindows: 10, partialWindows: 0, failedWindows: 2 } }]) {
    const text = formatXHistory(job(extra), now);
    assert.doesNotMatch(text, /100%/);
    assert.ok(text.length <= 750);
  }
});

test('render failures preserve completed search coverage while archive work is not reported as globally finished', () => {
  const progress = { completedWindows: 10, totalWindows: 10, partialWindows: 0, failedWindows: 0 };
  const partial = formatXHistory(job({ status: 'partial', reason: 'X_RENDER_FAILED', phase: 'finished', fetchDone: true, progress }), now);
  assert.match(partial, /部分完成.*X_RENDER_FAILED/);
  assert.match(partial, /完成視窗 10\/10（100%）/);
  const archive = formatXHistory(job({ status: 'complete', phase: 'archive', fetchDone: true, reported: false, progress }), now);
  assert.match(archive, /歷史回補 @alice：封存中（搜尋完成）/);
});

test('only reported successful finished jobs announce archive completion', () => {
  const complete = formatXHistory(job({ status: 'complete', phase: 'finished', fetchDone: true, reported: true }), now);
  assert.match(complete, /歷史回補 @alice：封存完成/);
  const ready = compactXHistory(job({ status: 'ready', phase: 'finished', reported: true }));
  assert.match(ready, /歷史回補 @alice：封存完成/);
  const partial = formatXHistory(job({ status: 'partial', phase: 'finished', reported: true }), now);
  assert.match(partial, /歷史回補 @alice：部分完成/);
  assert.doesNotMatch(partial, /歷史回補 @alice：封存完成/);
  const unreported = formatXHistory(job({ status: 'complete', phase: 'finished', reported: false }), now);
  assert.doesNotMatch(unreported, /歷史回補 @alice：封存完成/);
});

test('legacy and malformed count fields show unknown totals rather than fabricated progress', () => {
  const legacy = formatXHistory({ username: 'alice', status: 'working', posts: 5, progress: { completedWindows: 4 } }, now);
  assert.match(legacy, /5 篇.*完成視窗 4/);
  assert.match(legacy, /總數待更新/);
  assert.doesNotMatch(legacy, /\d+%/);
  for (const value of [-1, NaN, Infinity, '10', 1.5, Number.MAX_VALUE]) {
    const text = formatXHistory(job({ posts: value, progress: { completedWindows: value, totalWindows: value } }), now);
    assert.doesNotMatch(text, /NaN|Infinity|undefined|(?:：| )-1(?:[； ，]|$)|\d+%/);
    assert.match(text, /待更新/);
  }
});

test('waiting states explain rate limits and a Hong Kong retry time without promising an ETA', () => {
  const text = formatXHistory(job({ status: 'retry', phase: 'waiting', reason: 'X_RATE_LIMITED', retryAt: now + 10 * 60000 }), now);
  assert.match(text, /限流.*等待重試/);
  assert.match(text, /X_RATE_LIMITED/);
  assert.match(text, /下次嘗試：香港時間.*18:10/);
  assert.match(text, /約 10 分鐘後/);
  assert.doesNotMatch(text, /預計完成|可能已過期/);
});

test('a healthy resumed job suppresses old retry errors while stale live progress remains visible', () => {
  const healthy = formatXHistory(job({ reason: 'X_OLD_ERROR', retryAt: now - 1000 }), now);
  assert.doesNotMatch(healthy, /X_OLD_ERROR|下次嘗試/);
  const stale = formatXHistory(job({ progressUpdatedAt: now - 6 * 60000 }), now);
  assert.match(stale, /進度超過 5 分鐘未更新/);
  const waiting = formatXHistory(job({ status: 'retry', phase: 'waiting', progressUpdatedAt: now - 6 * 60000 }), now);
  assert.doesNotMatch(waiting, /進度超過/);
});

test('unfinished archive and rendering phases report stale progress even after search has completed', () => {
  for (const phase of ['archive', 'rendering']) {
    const record = job({ status: 'complete', phase, reported: false, fetchDone: true, progressUpdatedAt: now - 6 * 60000 });
    assert.match(formatXHistory(record, now), /進度超過 5 分鐘未更新/);
    assert.doesNotMatch(formatXHistory({ ...record, status: 'retry' }, now), /進度超過/);
    assert.doesNotMatch(formatXHistory({ ...record, reported: true }, now), /進度超過/);
    assert.doesNotMatch(formatXHistory({ ...record, phase: 'finished' }, now), /進度超過/);
  }
});

test('archive and import progress use posts rather than files and never imply media finished at search completion', () => {
  const importing = formatXHistory(job({ status: 'importing', phase: 'importing', importedPosts: 12, posts: 40, fetchDone: true }), now);
  assert.match(importing, /匯入貼文資料：12\/40 篇/);
  const archive = formatXHistory(job({ status: 'complete', phase: 'archive', fetchDone: true, archive: { total: 40, done: 30, remaining: 10, failed: 2, unit: 'post' } }), now);
  assert.match(archive, /本機封存：已處理 30\/40 篇，剩餘 10 篇/);
  assert.match(archive, /失敗 2 篇/);
  assert.match(archive, /媒體仍待完成/);
  assert.doesNotMatch(archive, /30\/40 個檔案|全部完成/);
});

test('phase descriptions cover resolve, timelines, exports, indexes and required start dates', () => {
  const phases = { resolve: '解析帳號', timeline_posts: '近期貼文與回覆', timeline_media: '近期媒體', export: '匯出貼文資料',
    importing: '匯入共用封存', archive: '下載／檢查', rendering: '產生 Markdown', finished: '流程已結束', queued: '等待前方', needs_start: '指定回補起日' };
  for (const [phase, label] of Object.entries(phases)) assert.ok(formatXHistory(job({ phase, status: phase === 'needs_start' ? 'needs_start' : 'working' }), now).includes(label), phase);
});

test('formatter exposes only allowlisted presentation fields and bounds its output', () => {
  const text = formatXHistory(job({ username: '../BOB_SECRET', reason: 'https://token.invalid/SECRET', phase: 'COOKIE_SECRET',
    password: 'PASSWORD_SECRET', progress: { completedWindows: 1, totalWindows: 1, currentPass: 'PASS_SECRET', passes: Array(10000).fill({ name: 'PASS_SECRET', total: 2, completed: 1 }) } }), now);
  assert.doesNotMatch(text, /BOB_SECRET|SECRET|PASSWORD|COOKIE|PASS_SECRET/);
  assert.ok(text.length <= 750);
  assert.ok(compactXHistory(job()).length <= 180);
});

test('corrupt JSON string fields and inherited lookup names never throw or leak functions', () => {
  const corrupt = [null, {}, [], { toString: null }, { toString: [] }, ['constructor']];
  for (const value of corrupt) for (const key of ['status', 'phase', 'reason', 'username', 'id']) {
    const record = job({ status: 'retry', [key]: value });
    assert.doesNotThrow(() => formatXHistory(record, now), key);
    assert.doesNotThrow(() => compactXHistory(record), key);
    assert.ok(formatXHistory(record, now).length <= 750);
  }
  for (const value of [null, [], {}, 'bad']) assert.doesNotThrow(() => formatXHistory(value, now));
  for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    const text = formatXHistory(job({ status: name, phase: name }), now);
    assert.match(text, /狀態待確認/);
    assert.doesNotMatch(text, /function|native code|\[object Object\]/);
  }
});

test('actual running and archival jobs receive detailed slots before newer retries', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'x-status-order-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const names = ['alice', 'bob', 'carol', 'dave', 'erin'];
  const settings = { users: { '100': { daily: false, targets: {}, xTargets: Object.fromEntries(names.map(name => [name, {}])) } } };
  atomic(path.join(dir, 'x/health.json'), { at: Date.now(), historyJobs: [
    job({ id: 'running', username: 'alice', status: 'working', phase: 'resolve', requestedAt: now - 100000 }),
    job({ id: 'retry1', username: 'bob', status: 'retry', requestedAt: now + 2000 }),
    job({ id: 'retry2', username: 'carol', status: 'retry', requestedAt: now + 1000 }),
    job({ id: 'archival', username: 'dave', status: 'complete', phase: 'archive', fetchDone: true, requestedAt: now - 200000 }),
    job({ id: 'queued', username: 'erin', status: 'queued', phase: 'queued', requestedAt: now + 3000 }),
  ] });
  const text = describeUser(settings, '100', dir);
  assert.match(text, /目前：解析帳號與建立日期/);
  assert.match(text, /目前：下載／檢查本機媒體/);
  assert.ok(text.indexOf('歷史回補 @alice') < text.indexOf('歷史回補 @bob'));
  assert.ok(text.indexOf('歷史回補 @dave') < text.indexOf('歷史回補 @bob'));
  assert.ok(text.indexOf('歷史回補 @bob') < text.indexOf('歷史回補 @erin'));
});

test('corrupt report identity and ordering values cannot break the status command', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'x-status-corrupt-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const settings = { users: { '100': { daily: false, targets: {}, xTargets: { alice: {} } } } };
  const invalid = { toString: null, valueOf: null };
  atomic(path.join(dir, 'x/health.json'), { at: Date.now(), historyJobs: [
    { username: 'alice', id: invalid, start: invalid, end: invalid, status: invalid, phase: invalid, reason: invalid, at: now, requestedAt: invalid },
    { username: 'alice', id: 'second', status: 'working', requestedAt: invalid, at: now },
  ] });
  assert.doesNotThrow(() => describeUser(settings, '100', dir));
});

test('shared active jobs are visible only for subscribed targets and detailed reports prioritize current work', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'x-status-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const settings = { users: { '100': { daily: false, targets: {}, xTargets: { alice: {} } }, '200': { daily: false, targets: {}, xTargets: { bob: {} } } },
    xRequests: { '100-1-0': { id: '100-1-0', type: 'history', username: 'alice', userId: '100', at: now - 10000 },
      '200-2-0': { id: '200-2-0', type: 'history', username: 'bob', userId: '200', at: now } } };
  atomic(path.join(dir, 'x/jobs/100-1-0.json'), job({ id: 'same-job', username: 'alice', at: now - 10000, posts: 1, phase: 'resolve' }));
  atomic(path.join(dir, 'x/health.json'), { at: Date.now(), targets: [{ username: 'alice', saved: 2 }], pool: { active: 1, locked: 0 },
    historyJobs: [job({ id: 'same-job', username: 'alice', at: now }), job({ username: 'bob', reason: 'BOB_PRIVATE_ERROR' })] });
  const text = describeUser(settings, '100', dir);
  assert.match(text, /歷史回補 @alice：執行中/);
  assert.match(text, /目前：回覆補抓/);
  assert.match(text, /貼文資料 120 篇/);
  assert.equal(text.match(/歷史回補 @alice/g).length, 1);
  assert.doesNotMatch(text, /bob|BOB_PRIVATE_ERROR/);
  assert.ok(text.length <= 3400);
});
