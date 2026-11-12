import { chromium } from 'playwright-core';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseInstagramLink, shortcodeId } from './instagram-links.mjs';
import { normalizeManual, enrichDash } from './manual-media.mjs';
import { makeRequest, installCatalogGuard, decodeResponse } from './catalog-api.mjs';
import { ensureTargetUserId } from './target-user.mjs';

export function manualSpec(plan, target) {
  if (plan.kind === 'post') return { method: 'GET', path: `/api/v1/media/${shortcodeId(plan.shortcode)}/info/`, app: '936619743392459' };
  if (plan.kind === 'highlight') return makeRequest({ kind: 'highlight', id: plan.contentId }, { target: '0', username: 'manual' });
  if (plan.kind === 'story' && /^\d+$/.test(target || '')) return {
    method: 'POST', path: '/graphql/query', app: '936619743392459',
    rootField: 'xdt_api__v1__feed__reels_media',
    friendly: 'PolarisStoriesV3ReelPageStandaloneQuery', doc: '29184890191114309',
    variables: { reel_ids_arr: [target], __relay_internal__pv__PolarisCommunityNoteStoriesLabelEnabledrelayprovider: true },
  };
  throw Error('MANUAL_INVALID_PLAN');
}
export async function resolveShare(context, input) {
  let plan = input;
  for (let i = 0; i < 4 && plan.kind === 'share'; i++) {
    // APIRequestContext does not use page routes. Every hop is separately parsed,
    // canonicalized and restricted to an Instagram content/share URL before GET.
    const response = await context.request.get(plan.url, { maxRedirects: 0, timeout: 30000 });
    const status = response.status(), location = response.headers().location;
    await response.dispose();
    if (![301, 302, 303, 307, 308].includes(status) || !location) throw Error('MANUAL_SHARE_UNRESOLVED');
    const next = new URL(location, plan.url);
    if (/^\/(accounts\/login|challenge|checkpoint)(\/|$)/.test(next.pathname)) throw Error('MANUAL_SESSION_INVALID');
    plan = parseInstagramLink(next.href);
    if (plan.kind === 'profile') throw Error('MANUAL_SHARE_UNRESOLVED');
  }
  if (plan.kind === 'share') throw Error('MANUAL_SHARE_UNRESOLVED');
  return plan;
}
export async function fetchManualMedia(input, { browser = chromium, profile = '/data/profile', env = process.env } = {}) {
  let plan = parseInstagramLink(input.url), target, context;
  if (plan.kind === 'profile') throw Error('MANUAL_UNSUPPORTED_LINK');
  // A share redirect may reveal a Story owner; resolve it before opening the
  // persistent browser used for the exact content query.
  if (plan.kind === 'share') {
    context = await browser.launchPersistentContext(profile, { executablePath: '/usr/bin/chromium', headless: true, serviceWorkers: 'block', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    try { await context.route('**/*', route => route.abort()); plan = await resolveShare(context, plan); }
    finally { await context.close(); context = null; }
  }
  if (plan.kind === 'story') {
    try { target = await ensureTargetUserId({ ...env, IG_TARGET_USERNAME: plan.username, IG_TARGET_USER_ID: '' }, () => {}, { launchPersistentContext: (_path, options) => browser.launchPersistentContext(profile, options) }); }
    catch (error) {
      if (error.message === 'TARGET_SESSION_INVALID') throw Error('MANUAL_SESSION_INVALID');
      if (/^TARGET_LOOKUP_HTTP_\d+$/.test(error.message)) throw Error(error.message.replace('TARGET_LOOKUP_', 'MANUAL_'));
      throw error;
    }
  }
  const spec = manualSpec(plan, target);
  try {
    context = await browser.launchPersistentContext(profile, { executablePath: '/usr/bin/chromium', headless: true, serviceWorkers: 'block', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const guard = await installCatalogGuard(context, spec);
    const page = context.pages()[0] ?? await context.newPage();
    const response = await page.goto('https://www.instagram.com/accounts/edit/', { waitUntil: 'domcontentloaded', timeout: 45000 });
    const pathname = new URL(page.url()).pathname;
    if (/^\/(accounts\/login|challenge|checkpoint)(\/|$)/.test(pathname)) throw Error('MANUAL_SESSION_INVALID');
    if (response?.status() !== 200 || pathname !== '/accounts/edit/') throw Error(`MANUAL_BOOTSTRAP_HTTP_${response?.status() || 'ERROR'}`);
    const tokens = await page.evaluate(() => {
      const csrf = document.cookie.split(';').map(c => c.trim()).find(c => c.startsWith('csrftoken='))?.slice(10) || '';
      let lsd = '', fbDtsg = '';
      for (const script of document.querySelectorAll('script')) {
        const text = script.textContent || '';
        lsd ||= text.match(/"LSD",\[\],\{"token":"([^"]+)"/)?.[1] || text.match(/"name":"LSD".*?"token":"([^"]+)"/)?.[1] || '';
        const match = text.match(/"DTSGInitialData"\s*,\s*\[\s*\]\s*,\s*(\{[^}]*\})/);
        if (match) { try { fbDtsg ||= JSON.parse(match[1]).token || ''; } catch {} }
      }
      return { csrf, lsd, fbDtsg };
    });
    if (!tokens.csrf || (spec.friendly && (!tokens.lsd || !tokens.fbDtsg))) throw Error('MANUAL_BOOTSTRAP_TOKEN_ERROR');
    const raw = await page.evaluate(async ({ spec, tokens }) => {
      const headers = { 'X-CSRFToken': tokens.csrf, 'X-IG-App-ID': spec.app, 'X-Requested-With': 'XMLHttpRequest', Accept: '*/*' };
      let body;
      if (spec.friendly) {
        Object.assign(headers, { 'Content-Type': 'application/x-www-form-urlencoded', 'X-ASBD-ID': '359341', 'X-FB-Friendly-Name': spec.friendly, 'X-FB-LSD': tokens.lsd });
        if (spec.rootField) headers['X-Root-Field-Name'] = spec.rootField;
        body = new URLSearchParams({ __a: '1', __d: 'www', __user: '0', __comet_req: '7', fb_api_caller_class: 'RelayModern', server_timestamps: 'true',
          lsd: tokens.lsd, fb_dtsg: tokens.fbDtsg, jazoest: '2' + [...tokens.fbDtsg].reduce((n,c) => n+c.charCodeAt(0),0),
          fb_api_req_friendly_name: spec.friendly, doc_id: spec.doc, variables: JSON.stringify(spec.variables) }).toString();
      }
      const response = await fetch(spec.path, { method: spec.method, body, headers, credentials: 'include', redirect: 'error', signal: AbortSignal.timeout(45000) });
      return { status: response.status, text: await response.text() };
    }, { spec, tokens });
    if (raw.status !== 200) throw Error(`MANUAL_HTTP_${raw.status}`);
    const body = decodeResponse(raw);
    let items = plan.kind === 'post' ? body.items : plan.kind === 'story'
      ? body.data?.xdt_api__v1__feed__reels_media?.reels_media?.flatMap(r => r.items || [])
      : body.data?.xdt_api__v1__feed__reels_media__connection?.edges?.flatMap(e => e.node?.items || []);
    if (Array.isArray(items)) {
      const enriched = await page.evaluate(enrichDash, items);
      // Enrichment mutates only media variants; keep the original response identity.
      const byId = new Map(enriched.map(i => [String(i.pk ?? i.id), i]));
      for (const item of items) Object.assign(item, byId.get(String(item.pk ?? item.id)));
    }
    const result = normalizeManual(body, plan, target);
    if (guard.blockedReadReceipt || guard.allowedQuery !== 1) throw Error('MANUAL_GUARD_INVARIANT');
    return { ...result, requestedUrl: input.url, guard: { blockedReadReceipt: guard.blockedReadReceipt, allowedRead: guard.allowedQuery } };
  } finally { await context?.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await fetchManualMedia(JSON.parse(process.env.IG_MANUAL_PLAN || '{}'));
    fs.writeFileSync(process.env.IG_MANUAL_RESULT_FILE, JSON.stringify(result), { mode: 0o600, flag: 'wx' });
    console.log(JSON.stringify({ event: 'MANUAL_FETCH_RESULT', ok: true }));
  } catch (error) {
    const reason = /^(MANUAL|CATALOG)_[A-Z0-9_]+$/.test(error.message) ? error.message : 'MANUAL_BROWSER_OR_NETWORK_ERROR';
    console.log(JSON.stringify({ event: 'MANUAL_FETCH_RESULT', ok: false, reason })); process.exitCode = 1;
  }
}
