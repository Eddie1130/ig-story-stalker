import { chromium } from 'playwright-core';
import fs from 'node:fs';
import { installNetworkGuard } from './network-guard.mjs';

const LOG_FILE = '/app/logs/audit.log';
const CHROMIUM = '/usr/bin/chromium';

fs.mkdirSync('/app/logs', { recursive: true });

function log(event, data = {}) {
  const row = { ts: new Date().toISOString(), event, ...data };
  const line = JSON.stringify(row);
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

let browser;
let exitCode = 0;

try {
  log('GUARD_SELFTEST_START');

  browser = await chromium.launch({
    executablePath: CHROMIUM,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  const context = await browser.newContext();

  const guard = await installNetworkGuard(context, log, {
    mode: 'runtime',
    allowedGraphqlQueries: [],
    blockSubresources: true,
  });

  const page = await context.newPage();

  await page.goto('https://www.instagram.com/robots.txt', {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });

  await page.evaluate(async () => {
    try {
      await fetch('/graphql/query', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          fb_api_req_friendly_name: 'PolarisStoriesV3SeenMutation',
          variables: '{}',
          doc_id: '0',
        }),
      });
    } catch {}
  });

  await page.evaluate(async () => {
    try {
      await fetch('/graphql/query', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          fb_api_req_friendly_name: 'DefinitelyUnknownMutation',
          variables: '{}',
          doc_id: '0',
        }),
      });
    } catch {}
  });

  const pass =
    guard.blockedReadReceipt >= 1 &&
    guard.blockedUnknownPost >= 1;

  log(pass ? 'GUARD_SELFTEST_PASS' : 'GUARD_SELFTEST_FAIL', { guard });

  if (!pass) exitCode = 20;

  await context.close();
} catch (err) {
  log('GUARD_SELFTEST_ERROR', {
    message: err?.message ?? String(err),
    stack: err?.stack,
  });
  exitCode = 1;
} finally {
  if (browser) {
    try { await browser.close(); } catch {}
  }
  process.exit(exitCode);
}
