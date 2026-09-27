import { formatJST } from './time-jst.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const log = (event, data = {}) => console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...data }));
export function atomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + randomUUID() + '.tmp';
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}
export function load(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
}
export function safe(value) {
  return String(value ?? '').replace(/[^A-Za-z0-9_:.= -]/g, '').slice(0, 160);
}
export function queue(dir, kind, text, extra = {}) {
  const id = `${Date.now()}-${randomUUID()}`;
  atomic(path.join(dir, id + '.json'), { id, at: Date.now(), kind, text, ...extra });
  return id;
}
export class Issues {
  constructor(file, outbox, target) {
    this.file = file; this.outbox = outbox; this.target = target;
    this.state = load(file, {});
    if (!this.state || Array.isArray(this.state) || typeof this.state !== 'object') throw Error('INVALID_ISSUES_STATE');
    for (const entry of Object.values(this.state)) if (!entry || typeof entry.active !== 'boolean') throw Error('INVALID_ISSUE_ENTRY');
  }
  fail(key, reason) {
    const old = this.state[key];
    if (!old?.active || old.reason !== safe(reason)) queue(this.outbox, 'error', `IG 監控異常：${this.target}\n${safe(key)}\n${safe(reason)}\n時間：${formatJST()}`);
    this.state[key] = { active: true, reason: safe(reason), firstAt: old?.active ? old.firstAt : Date.now(), lastAt: Date.now(), count: (old?.count || 0) + 1 };
    atomic(this.file, this.state);
  }
  resolve(key) {
    const old = this.state[key];
    if (!old?.active) return;
    queue(this.outbox, 'recovery', `IG 監控異常已解除：${this.target}\n${safe(key)}\n先前：${old.reason}\n時間：${formatJST()}`);
    this.state[key] = { ...old, active: false, resolvedAt: Date.now() };
    atomic(this.file, this.state);
  }
  activeCount() { return Object.values(this.state).filter(x => x.active).length; }
}
export function staleReason(health, now = Date.now()) {
  if (!health || !Number.isFinite(health.at) || !Number.isFinite(health.workerDeadline)) return 'HEARTBEAT_MISSING_OR_INVALID';
  if (health.at > now + 60000) return 'HEARTBEAT_CLOCK_MISMATCH';
  if (now - health.at > 120000) return 'SUPERVISOR_HEARTBEAT_STALE';
  if (health.phase === 'stopped') return 'SUPERVISOR_STOPPED';
  if (health.phase === 'fatal') return 'SUPERVISOR_FATAL';
  if (health.workerDeadline < now) return 'WORKER_PROGRESS_DEADLINE_EXCEEDED';
  return null;
}
export function eventIssue(row) {
  const event = row?.event;
  if (event === 'WATCH_CHECK_FAILED') return ['fetch', row.reason || 'FETCH_FAILED'];
  if (event === 'WATCH_FATAL') return ['worker-fatal', row.reason || 'WORKER_FATAL'];
  if (event === 'STORY_MEDIA_RETRY') return [`media:${safe(row.id)}`, row.reason || 'MEDIA_SEND_FAILED'];
  if (event === 'TELEGRAM_DELIVERY_FAILED') return ['worker-telegram', row.reason || 'TELEGRAM_FAILED'];
  if (event === 'STORY_MEDIA_RETIRED') return [`media-retired:${safe(row.id)}`, 'MEDIA_ABANDONED_AFTER_RETRIES'];
  if (event === 'WATCH_MEDIA_CHECK_OK' && row.skippedCount > 0 && !Array.isArray(row.skippedIds)) return ['skipped-media', `SKIPPED_MEDIA_COUNT=${row.skippedCount}`];
  if (/ERROR|FAILED|FATAL|FAILURE|INVALID|RETRY|RETIRED|CRITICAL|WARNING/.test(event || '')) return [`event:${safe(event)}`, 'UNCLASSIFIED_ERROR_EVENT'];
  return null;
}
