
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const PROFILE_DIR = '/data/profile';
const LOG_FILE = '/app/logs/audit.log';
const CHROMIUM = '/usr/bin/chromium';

fs.mkdirSync('/app/logs', { recursive: true });
fs.mkdirSync(PROFILE_DIR, { recursive: true });

function log(event, data = {}) {
  const row = { ts: new Date().toISOString(), event, ...data };
  const line = JSON.stringify(row);
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

async function installSafetyGuard(context) {
  await context.route('**/*', async route => {
    const req = route.request();
    const url = req.url();
    const method = req.method();

    if (method === 'POST' && /instagram\.com/i.test(url)) {
      const body = req.postData() || '';
      if (
        /PolarisStoriesV3SeenMutation/i.test(body) ||
        /SeenMutation/i.test(body) ||
        /MarkThreadAsRead/i.test(body)
      ) {
        log('BLOCKED_READ_RECEIPT_REQUEST', {
          method,
          url,
          resourceType: req.resourceType(),
        });
        await route.abort('blockedbyclient');
        return;
      }
    }
    await route.continue();
  });
}

let context;
try {
  log('LOGIN_BROWSER_STARTING');
  context = await chromium.launchPersistentContext(PROFILE_DIR, {
    executablePath: CHROMIUM,
    headless: false,
    viewport: { width: 1280, height: 900 },
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  await installSafetyGuard(context);

  const page = context.pages()[0] ?? await context.newPage();
  await page.goto('https://www.instagram.com/accounts/login/', {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });

  log('LOGIN_PAGE_READY', {
    url: page.url(),
    message: 'Open noVNC and log in manually. Do not open Stories.'
  });

  await new Promise(() => {});
} catch (err) {
  log('LOGIN_FATAL', { message: err?.message, stack: err?.stack });
  process.exitCode = 1;
} finally {
  if (context) {
    try { await context.close(); } catch {}
  }
}
