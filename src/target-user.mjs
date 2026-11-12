import { chromium } from 'playwright-core';
import { installNetworkGuard } from './network-guard.mjs';

// Resolve once per worker lifetime, before opening any other persistent context.
// Only the process environment is updated; credentials/config files stay untouched.
export async function ensureTargetUserId(env = process.env, log = () => {}, browser = chromium) {
  const id = env.IG_TARGET_USER_ID || '';
  if (id) {
    if (!/^\d+$/.test(id)) throw Error('TARGET_CONFIG_ERROR');
    return id;
  }
  const username = env.IG_TARGET_USERNAME || '';
  if (!/^[A-Za-z0-9_.]{1,30}$/.test(username)) throw Error('TARGET_CONFIG_ERROR');
  log('TARGET_RESOLVE_START', { username });
  let context;
  try {
    context = await browser.launchPersistentContext('/data/profile', {
      executablePath: '/usr/bin/chromium', headless: true, serviceWorkers: 'block',
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
  } catch {
    throw Error('TARGET_BROWSER_START_ERROR');
  }
  let resolved, failure;
  try {
    const guard = await installNetworkGuard(context, log, { blockSubresources: true });
    const page = context.pages()[0] ?? await context.newPage();
    const response = await page.goto('https://www.instagram.com/accounts/edit/', {
      waitUntil: 'domcontentloaded', timeout: 45000,
    });
    const pathname = new URL(page.url()).pathname;
    if (/^\/(?:accounts\/login|challenge|checkpoint)(?:\/|$)/i.test(pathname)) throw Error('TARGET_SESSION_INVALID');
    if (response?.status() !== 200) throw Error(`TARGET_BOOTSTRAP_HTTP_${response?.status() ?? 'ERROR'}`);
    if (pathname !== '/accounts/edit/') throw Error('TARGET_BOOTSTRAP_UNEXPECTED_REDIRECT');
    const result = await page.evaluate(async username => {
      const response = await fetch(`/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`, {
        method: 'GET', credentials: 'include', redirect: 'error',
        headers: { 'X-IG-App-ID': '936619743392459', 'X-Requested-With': 'XMLHttpRequest' },
        signal: AbortSignal.timeout(30000),
      });
      if (response.status !== 200) return { status: response.status };
      try { return { status: response.status, body: await response.json() }; }
      catch { return { status: response.status, invalidJson: true }; }
    }, username);
    if (result.status !== 200) throw Error(`TARGET_LOOKUP_HTTP_${result.status}`);
    if (result.invalidJson) throw Error('TARGET_LOOKUP_INVALID_JSON');
    const user = result.body?.data?.user;
    const userId = user?.id;
    if ((result.body?.status && result.body.status !== 'ok') ||
        typeof user?.username !== 'string' || user.username.toLowerCase() !== username.toLowerCase() ||
        !['string', 'number'].includes(typeof userId) ||
        (typeof userId === 'number' && !Number.isSafeInteger(userId)) || !/^[1-9]\d*$/.test(String(userId))) {
      throw Error('TARGET_LOOKUP_INVALID_USER');
    }
    if (guard.blockedReadReceipt) throw Error('TARGET_GUARD_INVARIANT_FAILED');
    resolved = String(userId);
  } catch (error) {
    // Browser exceptions can contain response data; expose only stable diagnostics.
    failure = /^TARGET_[A-Z0-9_]+$/.test(error.message)
      ? error : Error('TARGET_LOOKUP_BROWSER_OR_NETWORK_ERROR');
    throw failure;
  } finally {
    try { await context.close(); }
    catch { if (!failure) throw Error('TARGET_BROWSER_CLOSE_ERROR'); }
  }
  env.IG_TARGET_USER_ID = resolved;
  log('TARGET_RESOLVED', { username, targetUserId: resolved });
  return resolved;
}
