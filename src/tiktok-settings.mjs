import { randomUUID } from 'node:crypto';
export const tikTokName = name => typeof name === 'string' && /^[a-z0-9_][a-z0-9_.]{0,23}$/.test(name) && !name.endsWith('.');
export const tikTokKinds = ['start', 'video'];
export const tikTokSubscription = now => ({ generation: randomUUID(), joinedAt: now, notifications: Object.fromEntries(tikTokKinds.map(k => [k, { enabled: true, since: now }])) });
export function validateTikTokSettings(s) {
  for (const user of Object.values(s.users)) {
    if (user.tiktokTargets === undefined) continue;
    if (!user.tiktokTargets || typeof user.tiktokTargets !== 'object' || Array.isArray(user.tiktokTargets)) throw Error('TIKTOK_SETTINGS_INVALID');
    for (const [name, sub] of Object.entries(user.tiktokTargets)) {
      if (!tikTokName(name) || !/^[a-f0-9-]{36}$/.test(sub?.generation || '') || !Number.isFinite(sub.joinedAt) || tikTokKinds.some(k => typeof sub.notifications?.[k]?.enabled !== 'boolean' || !Number.isFinite(sub.notifications[k].since))) throw Error('TIKTOK_SETTINGS_INVALID');
    }
  }
}
export function seedTikTok(s, env, now) {
  if (s.tiktokInitialized) return;
  const names = [...new Set((env.TIKTOK_TARGET_USERNAMES || '').split(',').map(n => n.trim().replace(/^@/, '').toLowerCase()).filter(Boolean))];
  if (!names.every(tikTokName)) throw Error('TIKTOK_TARGET_CONFIG_INVALID');
  const user = s.users[s.ownerId]; user.tiktokTargets ||= {};
  for (const name of names) if (!Object.hasOwn(user.tiktokTargets, name)) Object.defineProperty(user.tiktokTargets, name, { value: tikTokSubscription(now), enumerable: true, writable: true, configurable: true });
  s.tiktokInitialized = true;
}
