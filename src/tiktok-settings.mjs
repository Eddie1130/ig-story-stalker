import { randomUUID } from 'node:crypto';
export const tikTokName = name => typeof name === 'string' && /^[a-z0-9_][a-z0-9_.]{0,23}$/.test(name) && !name.endsWith('.');
export const tikTokContentKinds = ['post', 'repost', 'story', 'profile', 'like'];
export const tikTokKinds = ['start', 'video', ...tikTokContentKinds];
export const tikTokLabels = { start: '開播通知', video: '直播完成後傳送影片', post: '貼文／照片', repost: '轉發', story: 'Story', profile: '個人資料變更', like: '公開讚好清單' };
export const tikTokSubscription = now => ({ generation: randomUUID(), joinedAt: now, notifications: Object.fromEntries(tikTokKinds.map(k => [k, { enabled: k !== 'like', since: now }])) });
export function validateTikTokSettings(s) {
  for (const user of Object.values(s.users)) {
    if (user.tiktokTargets === undefined) continue;
    if (!user.tiktokTargets || typeof user.tiktokTargets !== 'object' || Array.isArray(user.tiktokTargets)) throw Error('TIKTOK_SETTINGS_INVALID');
    for (const [name, sub] of Object.entries(user.tiktokTargets)) {
      if (!tikTokName(name) || !/^[a-f0-9-]{36}$/.test(sub?.generation || '') || !Number.isFinite(sub.joinedAt) || tikTokKinds.some(k => tikTokContentKinds.includes(k) && sub.notifications?.[k] === undefined ? false : typeof sub.notifications?.[k]?.enabled !== 'boolean' || !Number.isFinite(sub.notifications[k].since))) throw Error('TIKTOK_SETTINGS_INVALID');
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

export function migrateTikTokContent(s, now) {
  for (const user of Object.values(s.users)) for (const sub of Object.values(user.tiktokTargets || {})) {
    for (const kind of tikTokContentKinds) if (!Object.hasOwn(sub.notifications, kind)) sub.notifications[kind] = { enabled: kind !== 'like', since: now };
  }
  s.tiktokContentVersion = 1;
}
