import { parseInstagramLink, manualJobId } from './instagram-links.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomic, load } from './error-monitor.mjs';
import { configuredTargets } from './target-config.mjs';
import { validateTikTokSettings, seedTikTok, migrateTikTokContent } from './tiktok-settings.mjs';
import { validateXSettings, configuredXTargets } from './x-settings.mjs';
import { validateExportSettings } from './archive-export.mjs';

export const kinds = ['story', 'post', 'highlight'];
export const validUsername = name => typeof name === 'string' && /^[a-z0-9_.]{1,30}$/.test(name) && !['.', '..'].includes(name);
const userId = id => /^[1-9]\d{0,19}$/.test(String(id));
export const own = (map, key) => Object.hasOwn(map, key) ? map[key] : undefined;
export const put = (map, key, value) => Object.defineProperty(map, key, { value, enumerable: true, configurable: true, writable: true });
export const userTarget = (user, name) => user?.targets ? own(user.targets, name) : undefined;
const object = v => v && typeof v === 'object' && !Array.isArray(v);
export const settingsFile = env => path.join(env.IG_CONTROL_DIR || '/app/control', 'settings.json');
export const controlEnabled = env => env.IG_TELEGRAM_CONTROL === '1';
export function subscription(now = Date.now()) {
  return { generation: randomUUID(), joinedAt: now, notifications: Object.fromEntries(kinds.map(k => [k, { enabled: true, since: now }])) };
}
export function validateSettings(s) {
  if (!object(s) || s.version !== 1 || !userId(s.ownerId) || !Array.isArray(s.allowedIds) || !s.allowedIds.every(userId) ||
      !s.allowedIds.includes(s.ownerId) || !object(s.users) || !Number.isSafeInteger(s.offset) || s.offset < 0 || !object(s.replies) || !object(s.legacyIds)) throw Error('TELEGRAM_SETTINGS_INVALID');
  if (s.manualRequests !== undefined) {
    if (!object(s.manualRequests)) throw Error('TELEGRAM_SETTINGS_INVALID');
    for (const [id, request] of Object.entries(s.manualRequests)) {
      if (!manualJobId(id) || request?.id !== id || !userId(request.userId) || !id.startsWith(request.userId + '-') || !Number.isFinite(request.at)) throw Error('TELEGRAM_SETTINGS_INVALID');
      const link = parseInstagramLink(request.url);
      if (link.kind === 'profile' || link.url !== request.url) throw Error('TELEGRAM_SETTINGS_INVALID');
    }
  }
  for (const [id, user] of Object.entries(s.users)) {
    if (!userId(id) || !object(user) || typeof user.daily !== 'boolean' || !object(user.targets)) throw Error('TELEGRAM_SETTINGS_INVALID');
    for (const [name, sub] of Object.entries(user.targets)) {
      if (!validUsername(name) || !object(sub) || typeof sub.generation !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(sub.generation) ||
          !Number.isFinite(sub.joinedAt) || !object(sub.notifications)) throw Error('TELEGRAM_SETTINGS_INVALID');
      for (const kind of kinds) if (typeof sub.notifications[kind]?.enabled !== 'boolean' || !Number.isFinite(sub.notifications[kind]?.since)) throw Error('TELEGRAM_SETTINGS_INVALID');
    }
  }
  for (const [name, id] of Object.entries(s.legacyIds)) if (!validUsername(name) || !/^\d+$/.test(id)) throw Error('TELEGRAM_SETTINGS_INVALID');
  validateXSettings(s);
  validateTikTokSettings(s);
  validateExportSettings(s);
  return s;
}
export function readSettings(file) {
  const s = load(file, null);
  if (!s) throw Error('TELEGRAM_SETTINGS_NOT_READY');
  return validateSettings(s);
}
export function initializeSettings(env, now = Date.now()) {
  const file = settingsFile(env), required = file + '.required';
  if (fs.existsSync(required) && !fs.existsSync(file)) throw Error('TELEGRAM_SETTINGS_HISTORY_MISSING');
  let s = load(file, null);
  const ownerId = String(env.TELEGRAM_OWNER_USER_ID || (/^[1-9]\d*$/.test(env.TELEGRAM_CHAT_ID || '') ? env.TELEGRAM_CHAT_ID : ''));
  const allowedIds = [...new Set([ownerId, ...(env.TELEGRAM_ALLOWED_USER_IDS || '').split(',').map(id => id.trim()).filter(Boolean)])];
  if (!userId(ownerId) || !allowedIds.every(userId)) throw Error('TELEGRAM_ALLOWED_USERS_CONFIG_ERROR');
  if (s === null && !fs.existsSync(file)) {
    const targets = [env.IG_TARGET_USERNAMES, env.IG_TARGET_USERNAME, env.IG_TARGET_USER_ID].some(v => v?.trim()) ? configuredTargets(env) : [];
    s = { version: 1, ownerId, allowedIds, offset: 0, users: {}, replies: {}, legacyIds: {} };
    s.users[ownerId] = { daily: false, targets: Object.fromEntries(targets.map(t => [t.username, subscription(now)])), xTargets: configuredXTargets(env.X_TARGET_USERNAMES, now) };
    for (const t of targets) if (t.target) put(s.legacyIds, t.username, t.target);
  } else {
    validateSettings(s);
    if (s.ownerId !== ownerId) throw Error('TELEGRAM_OWNER_CHANGE_REQUIRES_MIGRATION');
    s.allowedIds = allowedIds;
  }
  for (const id of allowedIds) s.users[id] ||= { daily: false, targets: {} };
  seedTikTok(s, env, now);
  migrateTikTokContent(s, now);
  atomic(file, validateSettings(s));
  if (!fs.existsSync(required)) fs.writeFileSync(required, 'required', { mode: 0o600, flag: 'wx' });
  return s;
}
export function targetConfigs(s) {
  const names = new Set(s.allowedIds.flatMap(id => Object.keys(s.users[id]?.targets || {})));
  return [...names].map(username => ({ username, ...(own(s.legacyIds, username) ? { target: own(s.legacyIds, username) } : {}) }));
}
export function subscribed(s, id, username) {
  return s.allowedIds.includes(id) ? userTarget(s.users[id], username) : undefined;
}
export const serviceUnavailableText = '服務暫時無法使用，請稍後再試；如持續無法使用，請聯絡管理員。';
export function isSystemAlert(alert) {
  // Storage/session/service incidents are global even if emitted while processing an account.
  const issueKey = (alert.issueKey || '').replace(/^target:[^:]+:/, '');
  return !alert.username || /^(?:NAS_(?:ENOSPC|EDQUOT|EIO|EROFS)|SESSION_|HEARTBEAT_|SUPERVISOR_|WORKER_)/.test(alert.reason || '') || /^(?:shared-session|worker-|watchdog-|supervisor|nas-storage)/.test(issueKey);
}
export function alertText(s, id, alert) {
  if (id === s.ownerId || !isSystemAlert(alert)) return alert.text;
  return alert.kind === 'recovery' ? '服務已恢復，可以繼續使用。如仍有問題，請聯絡管理員。' : serviceUnavailableText;
}
export function alertRecipients(s, alert) {
  return s.allowedIds.filter(id => isSystemAlert(alert) || (alert.usernames?.length ? alert.usernames : [alert.username]).some(name => subscribed(s, id, name)));
}
