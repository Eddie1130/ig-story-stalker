import { chromium } from 'playwright-core';
import fs from 'node:fs';
import { installNetworkGuard } from './network-guard.mjs';

const PROFILE_DIR = '/data/profile';
const LOG_FILE = '/app/logs/audit.log';
const CHROMIUM = '/usr/bin/chromium';

fs.mkdirSync('/app/logs', { recursive: true });
fs.mkdirSync(PROFILE_DIR, { recursive: true });

function log(event, data = {}) {
  const row = {
    ts: new Date().toISOString(),
    event,
    ...data,
  };

  const line = JSON.stringify(row);
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

let context;
let exitCode = 0;

try {
  log('SESSION_CHECK_START');

  context = await chromium.launchPersistentContext(PROFILE_DIR, {
    executablePath: CHROMIUM,
    headless: true,
    viewport: {
      width: 1280,
      height: 900,
    },
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
    ],
  });

  /*
   * Fail-closed runtime guard.
   *
   * Step 2 deliberately allows ZERO Instagram GraphQL POST requests.
   */
  const guard = await installNetworkGuard(
    context,
    log,
    {
      mode: 'runtime',
      allowedGraphqlQueries: [],
      blockSubresources: true,
    },
  );

  const pages = context.pages();
  const page = pages[0] ?? await context.newPage();

  const response = await page.goto(
    'https://www.instagram.com/accounts/edit/',
    {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    },
  );

  const finalUrl = page.url();
  const status = response?.status() ?? null;

  const looksLoggedOut =
    /\/accounts\/login/i.test(finalUrl) ||
    /\/challenge/i.test(finalUrl) ||
    /\/checkpoint/i.test(finalUrl);

  if (looksLoggedOut) {
    log('SESSION_INVALID', {
      status,
      finalUrl,
      guard,
    });

    exitCode = 2;
  } else {
    log('SESSION_OK', {
      status,
      finalUrl,
      guard,
    });
  }

  /*
   * Safety invariant:
   *
   * The normal session check should never even attempt a Story seen/read
   * mutation. If it does, Network Guard will already have blocked it,
   * but we still treat the run as a critical failure.
   */
  if (guard.blockedReadReceipt > 0) {
    log('CRITICAL_GUARD_INVARIANT_FAILURE', {
      reason:
        'A read-receipt request was attempted and blocked.',
      guard,
    });

    exitCode = 10;
  }

} catch (err) {
  log('SESSION_CHECK_ERROR', {
    message: err?.message ?? String(err),
    stack: err?.stack,
  });

  exitCode = 1;

} finally {
  if (context) {
    try {
      await context.close();
    } catch (err) {
      log('BROWSER_CLOSE_ERROR', {
        message: err?.message ?? String(err),
      });

      if (exitCode === 0) {
        exitCode = 1;
      }
    }
  }

  process.exit(exitCode);
}
