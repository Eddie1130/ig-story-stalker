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
