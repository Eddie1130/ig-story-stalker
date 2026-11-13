// Run once with the existing bot poller stopped. Never print credentials.
import fs from 'node:fs';
const values = Object.fromEntries(fs.readFileSync('.env.telegram', 'utf8').split(/\r?\n/).filter(l => /^[A-Z_]+=/.test(l)).map(l => {
  const at = l.indexOf('='); let value = l.slice(at + 1).trim();
  if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
  return [l.slice(0, at), value];
}));
const token = values.TELEGRAM_BOT_TOKEN;
if (!/^\d+:[A-Za-z0-9_-]+$/.test(token || '')) throw Error('INVALID_TELEGRAM_CONFIG');
try {
  const response = await fetch(`https://api.telegram.org/bot${token}/logOut`, { method: 'POST', signal: AbortSignal.timeout(30000) });
  const result = await response.json();
  if (!response.ok || result.ok !== true) throw Error('TELEGRAM_CLOUD_LOGOUT_REJECTED');
  console.log('Telegram cloud logOut complete. Start the Local Bot API and shared poller.');
} catch { console.error('Telegram cloud logOut failed; endpoint migration was not confirmed.'); process.exitCode = 1; }
