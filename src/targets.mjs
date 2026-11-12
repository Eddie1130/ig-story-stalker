import { ensureTargetUserId } from './target-user.mjs';

export { configuredTargets } from './target-config.mjs';

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
    catalogOk: targets.every(t => t.catalogOk), nextFetchAt: (targets.length ? Math.min(...targets.map(t => t.nextFetchAt)) : Date.now() + 5000),
  };
}
