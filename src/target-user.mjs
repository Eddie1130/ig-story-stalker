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
    const profile = await page.goto(`https://www.instagram.com/${username}/`, {
      waitUntil: 'domcontentloaded', timeout: 45000,
    });
    const profilePath = new URL(page.url()).pathname;
    if (/^\/(?:accounts\/login|challenge|checkpoint)(?:\/|$)/i.test(profilePath)) throw Error('TARGET_SESSION_INVALID');
    if (profile?.status() !== 200) throw Error(`TARGET_LOOKUP_HTTP_${profile?.status() ?? 'ERROR'}`);
    if (profilePath.toLowerCase() !== `/${username.toLowerCase()}/`) throw Error('TARGET_LOOKUP_UNEXPECTED_REDIRECT');
    // External scripts stay blocked. Parse embedded JSON without evaluating its contents.
    const scripts = await page.evaluate(() => Array.from(
      document.querySelectorAll('script[type="application/json"]'), script => script.textContent || '',
    ));
    const userId = profileUserId(scripts, username);
    if (guard.blockedReadReceipt) throw Error('TARGET_GUARD_INVARIANT_FAILED');
    resolved = userId;
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

// Instagram's Relay "id" may be opaque; the numeric account ID is "pk".
export function profileUserId(scripts, username) {
  const ids = new Set();
  const addId = id => {
    if ((typeof id === 'string' || (typeof id === 'number' && Number.isSafeInteger(id))) && /^[1-9]\d*$/.test(String(id))) {
      ids.add(String(id));
    }
  };
  const matches = name => typeof name === 'string' && name.toLowerCase() === username.toLowerCase();
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    const user = value.xig_user_by_username;
    if (user && matches(user.username)) addId(user.pk);
    // Logged-in pages embed profile identity in the initial route instead.
    // Tie IDs to that route's username, never to arbitrary profile_id fields.
    const route = value.initialRouteInfo?.route;
    if (route && matches(route.params?.username)) {
      for (const view of [route.rootView, route.hostableView]) {
        addId(view?.props?.page_logging?.params?.profile_id);
      }
    }
    for (const child of Object.values(value)) visit(child);
  };
  for (const script of scripts) {
    let data;
    try { data = JSON.parse(script); } catch { continue; }
    visit(data);
  }
  if (ids.size !== 1) throw Error('TARGET_LOOKUP_INVALID_USER');
  return [...ids][0];
}
