import test from 'node:test';
import assert from 'node:assert/strict';

// Dynamic import lets the missing implementation produce an executed RED test.
const resolve = async (...args) => (await import('../src/target-user.mjs')).ensureTargetUserId(...args);

function browserFixture({ status = 200, pathname = '/accounts/edit/', result, receipt = false } = {}) {
  const calls = { launches: 0, closed: 0, requests: [] };
  let routeHandler, currentUrl;
  const page = {
    goto: async url => {
      calls.requests.push({ url });
      currentUrl = calls.requests.length === 1
        ? `https://www.instagram.com${pathname}` : url;
      if (receipt && calls.requests.length === 2) await routeHandler({ request: () => ({ method: () => 'POST', url: () => 'https://www.instagram.com/graphql/query', postData: () => 'operationName=SeenMutation', resourceType: () => 'fetch' }), abort: async () => {}, continue: async () => {} });
      return { status: () => calls.requests.length === 1 ? status : result?.status ?? 200 };
    },
    url: () => currentUrl,
    evaluate: async fn => {
      const original = globalThis.document;
      globalThis.document = { querySelectorAll: () => [{ textContent: result?.invalidJson ? 'invalid' : JSON.stringify(result?.body ?? {
        require: [['ScheduledServerJS', 'handle', { __bbox: { result: { data: {
          xig_user_by_username: { pk: '9007199254740993123', id: 'opaque-relay-id', username: 'Example.User' },
        } } } }]],
      }) }] };
      try { return await fn(); } finally { globalThis.document = original; }
    },
  };
  const chromium = { launchPersistentContext: async () => {
    calls.launches++;
    return { route: async (_, handler) => { routeHandler = handler; }, pages: () => [page], close: async () => { calls.closed++; } };
  } };
  return { calls, chromium };
}

test('username alone resolves an exact numeric ID and shares it with child fetchers', async () => {
  const f = browserFixture(), env = { IG_TARGET_USERNAME: 'Example.User' };
  assert.equal(await resolve(env, () => {}, f.chromium), '9007199254740993123');
  assert.equal(env.IG_TARGET_USER_ID, '9007199254740993123');
  assert.equal(f.calls.closed, 1);
  assert.equal(f.calls.requests[1].url, 'https://www.instagram.com/Example.User/');
  await resolve(env, () => {}, f.chromium);
  assert.equal(f.calls.launches, 1);
});

test('manual ID remains supported without starting Chromium', async () => {
  const f = browserFixture();
  assert.equal(await resolve({ IG_TARGET_USER_ID: '123' }, () => {}, f.chromium), '123');
  assert.equal(f.calls.launches, 0);
});

test('missing or invalid target configuration fails before any request', async () => {
  for (const env of [{}, { IG_TARGET_USERNAME: '../evil' }, { IG_TARGET_USERNAME: 'x?y' }, { IG_TARGET_USER_ID: 'abc', IG_TARGET_USERNAME: 'example' }]) {
    const f = browserFixture();
    await assert.rejects(resolve(env, () => {}, f.chromium), /TARGET_CONFIG_ERROR/);
    assert.equal(f.calls.launches, 0);
  }
});

test('bootstrap HTTP and session errors close Chromium and leave ID unset', async () => {
  for (const [options, error] of [
    [{ status: 429 }, /TARGET_BOOTSTRAP_HTTP_429/],
    [{ pathname: '/accounts/login/' }, /TARGET_SESSION_INVALID/],
    [{ pathname: '/challenge/' }, /TARGET_SESSION_INVALID/],
    [{ pathname: '/' }, /TARGET_BOOTSTRAP_UNEXPECTED_REDIRECT/],
  ]) {
    const f = browserFixture(options), env = { IG_TARGET_USERNAME: 'example.user' };
    await assert.rejects(resolve(env, () => {}, f.chromium), error);
    assert.equal(f.calls.closed, 1);
    assert.equal(env.IG_TARGET_USER_ID, undefined);
    assert.equal(f.calls.requests.length, 1);
  }
});

test('lookup errors, absent users, wrong accounts and unsafe numeric IDs fail closed', async () => {
  for (const [result, error] of [
    [{ status: 404 }, /TARGET_LOOKUP_HTTP_404/],
    [{ status: 429 }, /TARGET_LOOKUP_HTTP_429/],
    [{ invalidJson: true }, /TARGET_LOOKUP_INVALID_USER/],
    [{ body: { status: 'fail' } }, /TARGET_LOOKUP_INVALID_USER/],
    [{ body: { data: { xig_user_by_username: { id: '123', username: 'someone.else' } } } }, /TARGET_LOOKUP_INVALID_USER/],
    [{ body: { data: { xig_user_by_username: { id: 9007199254740992, username: 'example.user' } } } }, /TARGET_LOOKUP_INVALID_USER/],
    [{ body: { data: { xig_user_by_username: { id: 'bad', username: 'example.user' } } } }, /TARGET_LOOKUP_INVALID_USER/],
  ]) {
    const f = browserFixture({ result }), env = { IG_TARGET_USERNAME: 'example.user' };
    await assert.rejects(resolve(env, () => {}, f.chromium), error);
    assert.equal(f.calls.closed, 1);
    assert.equal(env.IG_TARGET_USER_ID, undefined);
  }
});

test('a blocked read receipt prevents accepting the resolved ID', async () => {
  const f = browserFixture({ receipt: true }), env = { IG_TARGET_USERNAME: 'example.user' };
  await assert.rejects(resolve(env, () => {}, f.chromium), /TARGET_GUARD_INVARIANT_FAILED/);
  assert.equal(env.IG_TARGET_USER_ID, undefined);
  assert.equal(f.calls.closed, 1);
});

test('default logger works and browser exceptions do not expose private diagnostics', async () => {
  const f = browserFixture();
  assert.equal(await resolve({ IG_TARGET_USERNAME: 'example.user' }, undefined, f.chromium), '9007199254740993123');
  const broken = browserFixture();
  // Model a network failure within the browser callback.
  const launch = broken.chromium.launchPersistentContext;
  broken.chromium.launchPersistentContext = async (...args) => {
    const context = await launch(...args);
    context.pages()[0].evaluate = async () => { throw Error('https://private.example/?token=secret'); };
    return context;
  };
  await assert.rejects(resolve({ IG_TARGET_USERNAME: 'example.user' }, undefined, broken.chromium), /^Error: TARGET_LOOKUP_BROWSER_OR_NETWORK_ERROR$/);
  assert.equal(broken.calls.closed, 1);
});


test('browser launch and close failures use safe diagnostics and preserve lookup errors', async () => {
  await assert.rejects(resolve({ IG_TARGET_USERNAME: 'example.user' }, undefined, {
    launchPersistentContext: async () => { throw Error('private browser path'); },
  }), /^Error: TARGET_BROWSER_START_ERROR$/);
  for (const status of [200, 429]) {
    const f = browserFixture({ status });
    const launch = f.chromium.launchPersistentContext;
    f.chromium.launchPersistentContext = async (...args) => {
      const context = await launch(...args);
      context.close = async () => { throw Error('private browser path'); };
      return context;
    };
    const env = { IG_TARGET_USERNAME: 'example.user' };
    await assert.rejects(resolve(env, undefined, f.chromium), status === 200
      ? /^Error: TARGET_BROWSER_CLOSE_ERROR$/ : /^Error: TARGET_BOOTSTRAP_HTTP_429$/);
    assert.equal(env.IG_TARGET_USER_ID, undefined);
  }
});
