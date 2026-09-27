import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { closeBrowserOnShutdown } from '../src/login-shutdown.mjs';

class FakeBrowserContext extends EventEmitter {
  closeCalls = 0;

  async close() {
    this.closeCalls += 1;
    this.emit('close');
  }
}

test('SIGINT closes Chromium before resolving', async () => {
  const browserContext = new FakeBrowserContext();
  const signals = new EventEmitter();
  const shutdown = closeBrowserOnShutdown(browserContext, signals);

  signals.emit('SIGINT');

  assert.equal(await shutdown, 'SIGINT');
  assert.equal(browserContext.closeCalls, 1);
  assert.equal(signals.listenerCount('SIGINT'), 0);
  assert.equal(signals.listenerCount('SIGTERM'), 0);
});

test('SIGTERM closes Chromium before resolving', async () => {
  const browserContext = new FakeBrowserContext();
  const signals = new EventEmitter();
  const shutdown = closeBrowserOnShutdown(browserContext, signals);

  signals.emit('SIGTERM');

  assert.equal(await shutdown, 'SIGTERM');
  assert.equal(browserContext.closeCalls, 1);
});

test('repeated shutdown signals close Chromium only once', async () => {
  const browserContext = new FakeBrowserContext();
  const signals = new EventEmitter();
  const shutdown = closeBrowserOnShutdown(browserContext, signals);

  signals.emit('SIGINT');
  signals.emit('SIGTERM');

  await shutdown;
  assert.equal(browserContext.closeCalls, 1);
});

test('closing the browser resolves without closing it again', async () => {
  const browserContext = new FakeBrowserContext();
  const signals = new EventEmitter();
  const shutdown = closeBrowserOnShutdown(browserContext, signals);

  browserContext.emit('close');

  assert.equal(await shutdown, 'browser_closed');
  assert.equal(browserContext.closeCalls, 0);
});
