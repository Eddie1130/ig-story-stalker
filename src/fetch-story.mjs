import { chromium } from 'playwright-core';
import fs from 'node:fs';
import { installNetworkGuard } from './network-guard.mjs';

const PROFILE_DIR = '/data/profile';
const LOG_FILE = '/app/logs/audit.log';
const CHROMIUM = '/usr/bin/chromium';

const TARGET_USERNAME = process.env.IG_TARGET_USERNAME || '';
const TARGET_USER_ID = process.env.IG_TARGET_USER_ID || '';

const STORY_FRIENDLY_NAME = 'PolarisStoriesV3ReelPageStandaloneQuery';
const STORY_DOC_ID = '29184890191114309';

fs.mkdirSync('/app/logs', { recursive: true });
fs.mkdirSync(PROFILE_DIR, { recursive: true });

function log(event, data = {}) {
  const row = { ts: new Date().toISOString(), event, ...data };
  const line = JSON.stringify(row);
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

function fail(code, event, data = {}) {
  log(event, data);
  process.exitCode = code;
}

let context;

try {
  if (!TARGET_USER_ID) {
    fail(3, 'CONFIG_ERROR', {
      message: 'IG_TARGET_USER_ID is required',
    });
    throw new Error('Missing IG_TARGET_USER_ID');
  }

  log('REQUEST_PATCH_VERSION', { version: 'HAR_AUTH_V2' });
  log('STORY_FETCH_START', {
    targetUsername: TARGET_USERNAME || null,
    targetUserId: TARGET_USER_ID,
  });

  context = await chromium.launchPersistentContext(PROFILE_DIR, {
    executablePath: CHROMIUM,
    headless: true,
    viewport: { width: 1280, height: 900 },
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  const guard = await installNetworkGuard(context, log, {
    mode: 'runtime',
    allowedGraphqlRules: [
      {
        friendlyName: STORY_FRIENDLY_NAME,
        docId: STORY_DOC_ID,
        targetUserId: TARGET_USER_ID,
      },
    ],
    blockSubresources: true,
  });

  const page = context.pages()[0] ?? await context.newPage();

  // Establish origin/session and read current CSRF/LSD tokens.
  const response = await page.goto('https://www.instagram.com/accounts/edit/', {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });

  const status = response?.status() ?? null;
  const finalUrl = page.url();

  if (
    /\/accounts\/login/i.test(finalUrl) ||
    /\/challenge/i.test(finalUrl) ||
    /\/checkpoint/i.test(finalUrl)
  ) {
    fail(2, 'SESSION_INVALID', { status, finalUrl, guard });
    throw new Error('Instagram session invalid/challenge');
  }

  if (status !== 200) {
    fail(4, 'BOOTSTRAP_HTTP_ERROR', { status, finalUrl, guard });
    throw new Error(`Bootstrap HTTP ${status}`);
  }

  const tokens = await page.evaluate(() => {
    const csrfCookie = document.cookie
      .split(';')
      .map(c => c.trim())
      .find(c => c.startsWith('csrftoken='));

    const csrf = csrfCookie
      ? csrfCookie.slice('csrftoken='.length)
      : '';

    let lsd = '';

    for (const script of document.querySelectorAll('script')) {
      const text = script.textContent || '';

      const m1 = text.match(/"LSD",\[\],\{"token":"([^"]+)"/);
      if (m1) {
        lsd = m1[1];
        break;
      }

      const m2 = text.match(/"name":"LSD".*?"token":"([^"]+)"/);
      if (m2) {
        lsd = m2[1];
        break;
      }
    }

    // HAR_AUTH_V2
    let fbDtsg = '';
    for (const script of document.querySelectorAll('script')) {
      const text = script.textContent || '';
      const pattern =
        /"DTSGInitialData"\s*,\s*\[\s*\]\s*,\s*(\{[^}]*\})/g;

      for (const match of text.matchAll(pattern)) {
        try {
          const data = JSON.parse(match[1]);
          if (typeof data.token === 'string' && data.token) {
            fbDtsg = data.token;
            break;
          }
        } catch {}
      }
      if (fbDtsg) break;
    }

    return { csrf, lsd, fbDtsg };
  });

  log('BOOTSTRAP_TOKENS', {
    csrfPresent: Boolean(tokens.csrf),
    lsdPresent: Boolean(tokens.lsd),
      fbDtsgPresent: Boolean(tokens.fbDtsg),
  });

  if (!tokens.csrf || !tokens.lsd || !tokens.fbDtsg) {
    fail(5, 'BOOTSTRAP_TOKEN_ERROR', {
      csrfPresent: Boolean(tokens.csrf),
      lsdPresent: Boolean(tokens.lsd),
      fbDtsgPresent: Boolean(tokens.fbDtsg),
      guard,
    });
    throw new Error('Missing CSRF, LSD or fb_dtsg token');
  }

  const result = await page.evaluate(
    async ({
      targetUserId,
      csrf,
      lsd,
      fbDtsg,
      friendlyName,
      docId,
    }) => {
      const params = new URLSearchParams();

      // HAR_REQUEST_ENVELOPE_V1
      params.set('__a', '1');
      params.set('__d', 'www');
      params.set('__user', '0');
      params.set('__comet_req', '7');
      params.set('fb_api_caller_class', 'RelayModern');
      params.set('server_timestamps', 'true');
      params.set('lsd', lsd);
      params.set('fb_api_req_friendly_name', friendlyName);
      params.set(
        'variables',
        JSON.stringify({
          reel_ids_arr: [String(targetUserId)],
          __relay_internal__pv__PolarisCommunityNoteStoriesLabelEnabledrelayprovider: true,
        }),
      );
      params.set('doc_id', docId);
      params.set('fb_dtsg', fbDtsg);

      let tokenSum = 0;
      for (let i = 0; i < fbDtsg.length; i++) {
        tokenSum += fbDtsg.charCodeAt(i);
      }
      params.set('jazoest', '2' + tokenSum);

      const resp = await fetch('/graphql/query', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-CSRFToken': csrf,
          'X-IG-App-ID': '936619743392459',
          'X-ASBD-ID': '359341',
          'X-FB-Friendly-Name': friendlyName,
          'X-FB-LSD': lsd,
          'X-IG-Max-Touch-Points': '0',
          'X-Root-Field-Name': 'xdt_api__v1__feed__reels_media',
        },
        body: params.toString(),
      });

      return {
        status: resp.status,
        url: resp.url,
        redirected: resp.redirected,
        contentType: resp.headers.get('content-type') || '',
        text: await resp.text(),
      };
    },
    {
      targetUserId: TARGET_USER_ID,
      csrf: tokens.csrf,
      lsd: tokens.lsd,
      fbDtsg: tokens.fbDtsg,
      friendlyName: STORY_FRIENDLY_NAME,
      docId: STORY_DOC_ID,
    },
  );

  log('STORY_HTTP_RESULT', {
    status: result.status,
    url: result.url,
    contentType: result.contentType,
    redirected: result.redirected,
    guard,
  });

  if (result.status !== 200) {
    fail(6, 'STORY_HTTP_ERROR', {
      status: result.status,
      url: result.url,
      contentType: result.contentType,
      bodyPreview: result.text.slice(0, 300),
      guard,
    });
    throw new Error(`Story GraphQL HTTP ${result.status}`);
  }

  const trimmed = result.text.trim();

  if (
    /text\/html/i.test(result.contentType) ||
    /^\s*(?:<!doctype\b|<html\b)/i.test(trimmed)
  ) {
    // Inspect text only; never navigate to or execute the returned HTML.
    const title = trimmed.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1]
      ?.replace(/\s+/g, ' ').trim().slice(0, 300) ?? '';

    const linkTags = trimmed.match(/<link\b[^>]*>/gi) ?? [];
    let canonical = '';

    for (const tag of linkTags) {
      const rel = tag.match(/\brel\s*=\s*(["'])(.*?)\1/i)?.[2] ?? '';
      if (!rel.split(/\s+/).some(value => value.toLowerCase() === 'canonical')) {
        continue;
      }

      const href = tag.match(/\bhref\s*=\s*(["'])(.*?)\1/i)?.[2] ?? '';

      try {
        const parsed = new URL(href.replace(/&amp;/gi, '&'), result.url);
        // Omit query strings and fragments from the canonical diagnostic.
        canonical = `${parsed.origin}${parsed.pathname}`;
      } catch {
        canonical = '(unparseable)';
      }
      break;
    }

    fail(7, 'STORY_HTML_REDIRECT_OR_FALLBACK', {
      status: result.status,
      url: result.url,
      redirected: result.redirected,
      title,
      canonical,
      contentType: result.contentType,
      bodyLength: result.text.length,
      guard,
    });

    throw new Error('Instagram returned HTML instead of GraphQL JSON');
  }

  let payload;
  try {
    const jsonText = result.text.replace(
      /^\s*for\s*\(\s*;\s*;\s*\)\s*;\s*/,
      '',
    );
    payload = JSON.parse(jsonText);
  } catch (err) {
    fail(8, 'STORY_JSON_PARSE_ERROR', {
      message: err?.message,
      bodyPreview: result.text.slice(0, 300),
      guard,
    });
    throw err;
  }

  if (payload?.error) {
    fail(12, 'STORY_SERVER_ERROR', {
      errorCode: payload.error,
      errorSummary: payload.errorSummary ?? null,
      errorDescription: payload.errorDescription ?? null,
      guard,
    });
    throw new Error('Instagram returned a server error');
  }

  if (Array.isArray(payload?.errors) && payload.errors.length) {
    fail(9, 'STORY_GRAPHQL_ERROR', {
      errors: payload.errors,
      guard,
    });
    throw new Error('GraphQL returned errors');
  }

  const reels =
    payload?.data?.xdt_api__v1__feed__reels_media?.reels_media;

  if (!Array.isArray(reels)) {
    fail(11, 'STORY_SCHEMA_ERROR', {
      topLevelKeys: Object.keys(payload || {}),
      guard,
    });
    throw new Error('Unexpected Story response schema');
  }

  const reel = reels.find(r =>
    String(r?.id ?? r?.user?.pk ?? '') === String(TARGET_USER_ID)
  ) ?? null;

  // RELIABILITY_FETCH_V1
  if ((reels.length > 0 && !reel) || (reel && !Array.isArray(reel.items))) {
    fail(11, 'STORY_REEL_SCHEMA_OR_TARGET_ERROR', { guard });
    throw new Error('Story target or items schema mismatch');
  }
  const items = reel ? reel.items : [];

  const summary = items.map(item => ({
    id: String(item?.pk ?? item?.id ?? ''),
    takenAt: item?.taken_at ?? null,
    expiringAt: item?.expiring_at ?? null,
    mediaType: item?.media_type ?? null,
    hasAudio: item?.has_audio ?? null,
    videoCount: Array.isArray(item?.video_versions)
      ? item.video_versions.length
      : 0,
    imageCount: Array.isArray(item?.image_versions2?.candidates)
      ? item.image_versions2.candidates.length
      : 0,
  }));

  // STORY_MEDIA_EXPORT_V1
  // A private IPC file keeps signed CDN URLs out of console/audit logs.
  // The parent accepts this file only after successful process exit.
  if (process.env.IG_STORY_RESULT_FILE) {
    const { buildMediaResult } = await import('./story-media.mjs');
    const media = buildMediaResult(
      items, TARGET_USER_ID, reel?.user?.username || TARGET_USERNAME,
      String(reel?.id ?? reel?.user?.pk ?? ''),
    );
    fs.writeFileSync(process.env.IG_STORY_RESULT_FILE, JSON.stringify(media), {
      mode: 0o600, flag: 'wx',
    });
  }

  log('STORY_FETCH_SUCCESS', {
    targetUsername:
      reel?.user?.username || TARGET_USERNAME || null,
    targetUserId: TARGET_USER_ID,
    storyCount: items.length,
    stories: summary,
    guard,
  });

  if (guard.blockedReadReceipt > 0) {
    fail(10, 'CRITICAL_GUARD_INVARIANT_FAILURE', {
      message: 'A read-receipt request was attempted and blocked.',
      guard,
    });
    throw new Error('Read-receipt attempt detected');
  }

} catch (err) {
  if (!process.exitCode) {
    fail(1, 'STORY_FETCH_FATAL', {
      message: err?.message ?? String(err),
      stack: err?.stack,
    });
  }
} finally {
  if (context) {
    try {
      await context.close();
    } catch (err) {
      log('BROWSER_CLOSE_ERROR', {
        message: err?.message ?? String(err),
      });
      if (!process.exitCode) process.exitCode = 1;
    }
  }
}
