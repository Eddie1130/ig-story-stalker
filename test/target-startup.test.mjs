import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

for (const name of ['watch-media', 'watch-story']) {
  for (const telegramOnly of [false, true]) {
    test(`${name}: ${telegramOnly ? 'Telegram test skips lookup' : 'username resolves before numeric history is opened'}`, async () => {
      const source = (await fs.readFile(new URL(`../src/${name}.mjs`, import.meta.url), 'utf8'))
        .replace(/^import .*;\n/gm, '').replace(/^export /gm, '');
      const env = { IG_TARGET_USERNAME: 'example', TELEGRAM_BOT_TOKEN: '123:abc', TELEGRAM_CHAT_ID: '456' };
      let resolutions = 0, pathReached = false;
      const sandbox = vm.createContext({
        process: { env, argv: telegramOnly ? ['node', 'script', '--test-telegram'] : [] },
        ensureTargetUserId: async actualEnv => { resolutions++; actualEnv.IG_TARGET_USER_ID = '123'; return '123'; },
        fs: { mkdirSync: () => { pathReached = true; throw Error('STOP_BEFORE_HISTORY'); } },
        console: { log: () => {} }, pathToFileURL: () => ({ href: 'unused' }),
      });
      // Keep the real main body, but invoke it explicitly to observe its rejection.
      const body = source.slice(0, source.indexOf(name === 'watch-media' ? '\nmain().catch' : '\nif (process.argv[1]'));
      await assert.rejects(vm.runInContext(`(async () => { ${body}\n await main(); })()`, sandbox), /STOP_BEFORE_HISTORY/);
      assert.equal(pathReached, true);
      assert.equal(resolutions, telegramOnly ? 0 : 1);
    });
  }
}
