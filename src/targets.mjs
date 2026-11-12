import { ensureTargetUserId } from './target-user.mjs';

export function configuredTargets(env = process.env) {
  if (env.IG_TARGET_USERNAMES?.trim()) {
    const names = env.IG_TARGET_USERNAMES.split(',').map(name => name.trim().toLowerCase());
    if (names.some(name => !/^[a-z0-9_.]{1,30}$/.test(name) || ['.', '..'].includes(name))) throw Error('TARGET_CONFIG_ERROR');
    return [...new Set(names)].map(username => ({ username }));
  }
  const username = env.IG_TARGET_USERNAME || '';
  const target = env.IG_TARGET_USER_ID || '';
  if ((username && (!/^[A-Za-z0-9_.]{1,30}$/.test(username) || ['.', '..'].includes(username))) ||
      (target && !/^\d+$/.test(target)) || (!username && !target)) throw Error('TARGET_CONFIG_ERROR');
  return [{ username: username.toLowerCase() || target, target: target || undefined }];
}

export function sessionInvalid(error) {
  return /(?:^|:)SESSION_INVALID(?:$|:)|^(?:TARGET|CATALOG)_SESSION_INVALID$/.test(error?.message || '');
}

export async function resolveTarget(config, env, log, resolver = ensureTargetUserId) {
  // Never let the legacy ID override an entry from the new username list.
  const isolated = { ...env, IG_TARGET_USERNAME: config.username, IG_TARGET_USER_ID: config.target || '' };
  return resolver(isolated, log);
}

export function targetIssueKey(row, key) {
  return (row.username || row.target) ? `target:${row.username || row.target}:${key}` : key;
}

export function aggregateHealth(watchers) {
  const targets = watchers.map(watcher => watcher.status());
  return {
    at: Date.now(), targets, failures: Math.max(0, ...targets.map(t => t.failures)),
    telegramOk: targets.every(t => t.telegramOk), archiveOk: targets.every(t => t.archiveOk),
    catalogOk: targets.every(t => t.catalogOk), nextFetchAt: Math.min(...targets.map(t => t.nextFetchAt)),
  };
}
