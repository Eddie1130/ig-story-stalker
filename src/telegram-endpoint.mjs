// A single endpoint also covers supervisor/watchdog fallback notifications.
export function telegramApiBase(env = process.env) {
  const value = env.TELEGRAM_BOT_API_URL || 'https://api.telegram.org';
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw Error('INVALID_TELEGRAM_API_URL');
  return url.origin;
}
export const telegramFileLimit = (env = process.env) => telegramApiBase(env) === 'https://api.telegram.org' ? 50_000_000 : 2_000_000_000;
