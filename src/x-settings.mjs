import { randomUUID } from 'node:crypto';
import { parseXLink, validXUsername, xKinds } from './x-model.mjs';

const object = value => value && typeof value === 'object' && !Array.isArray(value);
const userId = value => typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value);
export const xTarget = (user, name) => user?.xTargets && Object.hasOwn(user.xTargets, name) ? user.xTargets[name] : undefined;
export const putXTarget = (user, name, sub) => {
  user.xTargets ||= {};
  Object.defineProperty(user.xTargets, name, { value: sub, enumerable: true, configurable: true, writable: true });
};
export function xSubscription(now = Date.now()) {
  return { generation: randomUUID(), joinedAt: now, notifications: Object.fromEntries(xKinds.map(kind => [kind, { enabled: true, since: now }])) };
}
export function validXDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const timestamp = Date.parse(value + 'T00:00:00Z');
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value && value >= '2006-01-01';
}
export function validateXSettings(settings) {
  const invalid = () => { throw Error('TELEGRAM_SETTINGS_INVALID'); };
  for (const user of Object.values(settings.users)) {
    if (user.xTargets === undefined) continue;
    if (!object(user.xTargets)) invalid();
    for (const [name, sub] of Object.entries(user.xTargets)) {
      if (!validXUsername(name) || name !== name.toLowerCase() || !object(sub) || typeof sub.generation !== 'string' ||
          !/^[A-Za-z0-9-]{1,64}$/.test(sub.generation) || !Number.isFinite(sub.joinedAt) || !object(sub.notifications)) invalid();
      for (const kind of xKinds) if (typeof sub.notifications[kind]?.enabled !== 'boolean' || !Number.isFinite(sub.notifications[kind]?.since)) invalid();
    }
  }
  if (settings.xRequests === undefined) return;
  if (!object(settings.xRequests)) invalid();
  for (const [id, request] of Object.entries(settings.xRequests)) {
    if (!/^\d{1,20}-\d{1,16}-\d{1,2}$/.test(id) || !object(request) || request.id !== id || !userId(request.userId) ||
        !id.startsWith(request.userId + '-') || !Object.hasOwn(settings.users, request.userId) || !Number.isFinite(request.at) ||
        !validXUsername(request.username) || request.username !== request.username.toLowerCase() || !['manual', 'history'].includes(request.type)) invalid();
    if ((request.start !== undefined && !validXDate(request.start)) || (request.end !== undefined && !validXDate(request.end)) ||
        (request.start && request.end && request.start >= request.end)) invalid();
    if (request.type === 'manual') {
      let link;
      try { link = parseXLink(request.url); } catch { invalid(); }
      if (link.kind !== 'post' || link.username !== request.username || link.url !== request.url || request.start !== undefined || request.end !== undefined) invalid();
    } else if (request.url !== undefined) invalid();
  }
}

export function configuredXTargets(raw, now = Date.now()) {
  const targets = {};
  for (const value of String(raw || '').split(',').filter(value => value.trim())) {
    const name = value.trim().replace(/^@/, '').toLowerCase();
    if (!validXUsername(name)) throw Error('X_TARGET_CONFIG_INVALID');
    if (!Object.hasOwn(targets, name)) Object.defineProperty(targets, name, { value: xSubscription(now), enumerable: true, configurable: true, writable: true });
  }
  return targets;
}
