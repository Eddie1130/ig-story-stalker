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
export function recoverableIssue(key, reason) {
  // Authentication, state integrity and local storage require operator action.
  if (/SESSION_INVALID|RELOGIN|UNTRUSTED|CRITICAL_|GUARD_INVARIANT|HISTORY_|INVALID_MEDIA_STATE|MEDIA_STATE_|INVALID_PENDING_MEDIA|SETTINGS_INVALID|INVALID_CONFIG|NAS_INVALID_|CATALOG_INVALID_(HISTORY|PATH|CONFIG)|ENOSPC|EDQUOT|EACCES|EPERM|EROFS|ENOTDIR|NAS_ENOENT|NAS_EIO|(?:HTTP_|http=|TELEGRAM_(?:ERROR_|HTTP_)?)(401|403)(?:$|:)/.test(reason)) return false;
  const operation = key.replace(/^target:[^:]+:/, '');
  if (operation === 'target-runtime' && reason !== 'TARGET_RUNTIME_ERROR' && !/NETWORK|TIMEOUT|ECONN|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH/.test(reason)) return false;
  return /^(fetch|target-runtime|skipped-media|missing-media:.*|media:.*|archive:.*|catalog-(fetch|archive|telegram|caption):.*|worker-telegram)$/.test(operation);
}
export class Issues {
  constructor(file, outbox, target) {
    this.file = file; this.outbox = outbox; this.target = target;
    this.state = load(file, {});
    if (!this.state || Array.isArray(this.state) || typeof this.state !== 'object') throw Error('INVALID_ISSUES_STATE');
    for (const entry of Object.values(this.state)) if (!entry || typeof entry.active !== 'boolean') throw Error('INVALID_ISSUE_ENTRY');
  }
  fail(key, reason, label = this.target, scope = {}) {
    if (reason === 'TELEGRAM_RETRY_WAIT') return; // Waiting for a saved cooldown is not another attempt.
    const old = this.state[key];
    const retry = recoverableIssue(key, reason);
    const continuing = old?.active || old?.pending;
    const count = continuing ? (old.count || 0) + 1 : 1;
    const active = !!old?.active || !retry || count >= 3;
    if (active && (!old?.active || (!retry && old.reason !== safe(reason)))) queue(this.outbox, 'error', `IG 監控異常：${label}\n${safe(key)}\n${safe(reason)}\n時間：${formatJST()}`, { issueKey: key, reason: safe(reason), username: /^target:([^:]+):/.exec(key)?.[1], target: /^\d+$/.test(scope.target || '') ? scope.target : undefined, usernames: scope.usernames });
    this.state[key] = { active, pending: !active, label, target: scope.target, usernames: scope.usernames, reason: safe(reason), firstAt: continuing ? old.firstAt : Date.now(), lastAt: Date.now(), count };
    atomic(this.file, this.state);
  }
  resolve(key) {
    const old = this.state[key];
    if (!old?.active && !old?.pending) return;
    if (old.active) queue(this.outbox, 'recovery', `IG 監控異常已解除：${old.label || this.target}\n${safe(key)}\n先前：${old.reason}\n時間：${formatJST()}`, { issueKey: key, reason: old.reason, username: /^target:([^:]+):/.exec(key)?.[1], target: old.target, usernames: old.usernames });
    this.state[key] = { ...old, active: false, pending: false, count: 0, resolvedAt: Date.now() };
    atomic(this.file, this.state);
  }
  migrateAccount(username) {
    // Before multi-target support all account incidents used unprefixed keys.
    const accountKey = /^(?:fetch|nas-storage|catalog-storage|skipped-media|worker-telegram|(?:media|media-retired|missing-media|archive|catalog-fetch|catalog-archive|catalog-telegram|catalog-caption):.*)$/;
    let changed = false;
    for (const [key, issue] of Object.entries(this.state)) {
      if (!accountKey.test(key)) continue;
      const scoped = `target:${username}:${key}`;
      if (!this.state[scoped]) this.state[scoped] = { ...issue, label: '@' + username };
      delete this.state[key]; changed = true;
    }
    if (changed) atomic(this.file, this.state);
  }
  suspendAccount(username, target) {
    let changed = false;
    for (const [key, issue] of Object.entries(this.state)) {
      if ((issue.active || issue.pending) && key.startsWith('target:') && (key.startsWith(`target:${username}:`) || (target && issue.target === target))) {
        this.state[key] = { ...issue, active: false, pending: false, count: 0, suspended: true, resolvedAt: Date.now() }; changed = true;
      }
    }
    if (changed) atomic(this.file, this.state);
  }
  migrateTarget(target, username) {
    let changed = false;
    for (const [key, issue] of Object.entries(this.state)) {
      const match = /^target:([^:]+):(.*)$/.exec(key);
      if (!match || issue.target !== target || match[1] === username) continue;
      const next = `target:${username}:${match[2]}`;
      if (!this.state[next] || (!this.state[next].active && issue.active)) this.state[next] = { ...issue, label: '@' + username };
      delete this.state[key]; changed = true;
    }
    if (changed) atomic(this.file, this.state);
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
  if (event === 'WATCH_TARGET_FAILED') return ['target-runtime', row.reason || 'TARGET_RUNTIME_ERROR'];
  if (event === 'SHARED_SESSION_INVALID') return ['shared-session', 'SESSION_INVALID_RELOGIN_REQUIRED'];
  if (event === 'CATALOG_CHECK_FAILED') return [`catalog-fetch:${safe(row.scope || row.group)}`, row.reason || 'CATALOG_FETCH_FAILED'];
  if (event === 'CATALOG_STORAGE_ERROR') return ['catalog-storage', row.reason || 'CATALOG_STORAGE_FAILED'];
  if (event === 'CATALOG_ARCHIVE_RETRY') return [`catalog-archive:${safe(row.key)}`, row.reason || 'CATALOG_ARCHIVE_FAILED'];
  if (event === 'CATALOG_TELEGRAM_RETRY') return [`catalog-telegram:${safe(row.key)}`, row.reason || 'CATALOG_TELEGRAM_FAILED'];
  if (event === 'CATALOG_CAPTION_RETRY') return [`catalog-caption:${safe(row.id)}`, row.reason || 'CATALOG_CAPTION_FAILED'];
  if (event === 'NAS_STORAGE_ERROR') return ['nas-storage', row.reason || 'NAS_STORAGE_FAILED'];
  if (event === 'STORY_ARCHIVE_RETRY') return [`archive:${safe(row.id)}`, row.reason || 'NAS_DOWNLOAD_FAILED'];
  if (event === 'STORY_ARCHIVE_RETIRED') return [`archive:${safe(row.id)}`, 'NAS_ABANDONED_AFTER_7_DAYS'];
  if (event === 'WATCH_CHECK_FAILED') return ['fetch', row.reason || 'FETCH_FAILED'];
  if (event === 'WATCH_FATAL') return ['worker-fatal', row.reason || 'WORKER_FATAL'];
  if (event === 'STORY_MEDIA_RETRY') return [`media:${safe(row.id)}`, row.reason || 'MEDIA_SEND_FAILED'];
  if (event === 'TELEGRAM_DELIVERY_FAILED') return ['worker-telegram', row.reason || 'TELEGRAM_FAILED'];
  if (event === 'STORY_MEDIA_RETIRED') return [`media-retired:${safe(row.id)}`, 'MEDIA_ABANDONED_AFTER_RETRIES'];
  if (event === 'WATCH_MEDIA_CHECK_OK' && row.skippedCount > 0 && !Array.isArray(row.skippedIds)) return ['skipped-media', `SKIPPED_MEDIA_COUNT=${row.skippedCount}`];
  if (/ERROR|FAILED|FATAL|FAILURE|INVALID|RETRY|RETIRED|CRITICAL|WARNING/.test(event || '')) return [`event:${safe(event)}`, 'UNCLASSIFIED_ERROR_EVENT'];
  return null;
}
