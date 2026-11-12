import test from 'node:test';
import assert from 'node:assert/strict';
import * as media from '../src/story-media.mjs';
import fs from 'node:fs/promises';
import vm from 'node:vm';

// Execute the real catalog bootstrap against a controlled browser boundary.
async function catalogBootstrap(status, finalUrl) {
  const source = (await fs.readFile(new URL('../src/fetch-catalog.mjs', import.meta.url), 'utf8'))
    .replace(/^import .*;\n/gm, '');
  const rows = [];
  const page = { goto: async () => ({ status: () => status }), url: () => finalUrl,
    evaluate: async () => { throw Error('STOP_AFTER_BOOTSTRAP'); } };
  const context = { pages: () => [page], close: async () => {} };
  const sandbox = vm.createContext({
    chromium: { launchPersistentContext: async () => context },
    installCatalogGuard: async () => ({}), makeRequest: () => ({ doc: '123' }),
    process: { env: {} }, URL, console: { log: line => rows.push(JSON.parse(line)) },
  });
  await vm.runInContext(`(async () => { ${source} })()`, sandbox);
  return rows.find(row => row.event === 'CATALOG_FETCH_ERROR')?.reason;
}

test('catalog reports 503 as an HTTP failure rather than an expired session', async () => {
  assert.equal(await catalogBootstrap(503, 'https://www.instagram.com/accounts/edit/'), 'CATALOG_BOOTSTRAP_HTTP_503');
});

test('catalog distinguishes rate limiting, login redirects and unexpected redirects', async () => {
  assert.equal(await catalogBootstrap(429, 'https://www.instagram.com/accounts/edit/'), 'CATALOG_BOOTSTRAP_HTTP_429');
  for (const route of ['accounts/login/', 'challenge/', 'checkpoint/']) {
    assert.equal(await catalogBootstrap(200, `https://www.instagram.com/${route}`), 'CATALOG_SESSION_INVALID');
  }
  assert.equal(await catalogBootstrap(200, 'https://www.instagram.com/'), 'CATALOG_BOOTSTRAP_UNEXPECTED_REDIRECT');
});

test('media alerts preserve the original fetch failure and numeric diagnostics', () => {
  assert.equal(media.mediaFailureReason(Error('BOOTSTRAP_HTTP_ERROR:http=503:exit=4')), 'BOOTSTRAP_HTTP_ERROR:http=503:exit=4');
  assert.equal(media.mediaFailureReason(Error('SESSION_INVALID:http=200:exit=2')), 'SESSION_INVALID:http=200:exit=2');
  assert.equal(media.mediaFailureReason(Error('FETCH_TIMEOUT')), 'FETCH_TIMEOUT');
  assert.equal(media.mediaFailureReason(Error('UNTRUSTED_MEDIA_RESULT')), 'UNTRUSTED_MEDIA_RESULT');
});

test('media alerts never expose arbitrary exception text or URLs', () => {
  for (const message of ['ENOENT: open /private/result.json', 'BOOTSTRAP_HTTP_ERROR:https://secret.example', 'FETCH_ERROR:secret']) {
    assert.equal(media.mediaFailureReason(Error(message)), 'MEDIA_RESULT_READ_FAILED');
  }
});

