import test from 'node:test';
import assert from 'node:assert/strict';

// Dynamic import lets the missing implementation produce an executed RED test.
const resolve = async (...args) => (await import('../src/target-user.mjs')).ensureTargetUserId(...args);

function browserFixture({ status = 200, pathname = '/accounts/edit/', result, receipt = false } = {}) {
  const calls = { launches: 0, closed: 0, requests: [] };
  let routeHandler;
  const page = {
    goto: async () => ({ status: () => status }),
    url: () => `https://www.instagram.com${pathname}`,
    evaluate: async (fn, arg) => {
      // Execute the actual browser callback with a controlled fetch boundary.
      const original = globalThis.fetch;
      globalThis.fetch = async (url, options) => {
        calls.requests.push({ url, options });
        if (receipt) await routeHandler({ request: () => ({ method: () => 'POST', url: () => 'https://www.instagram.com/graphql/query', postData: () => 'operationName=SeenMutation', resourceType: () => 'fetch' }), abort: async () => {}, continue: async () => {} });
        return { status: result?.status ?? 200, json: async () => {
          if (result?.invalidJson) throw Error('private response');
          return result?.body ?? { status: 'ok', data: { user: { id: '9007199254740993123', username: 'Example.User' } } };
        } };
      };
      try { return await fn(arg); } finally { globalThis.fetch = original; }
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
  assert.equal(f.calls.requests[0].url, '/api/v1/users/web_profile_info/?username=Example.User');
  assert.equal(f.calls.requests[0].options.credentials, 'include');
  assert.equal(f.calls.requests[0].options.redirect, 'error');
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
    assert.equal(f.calls.requests.length, 0);
  }
});

test('lookup errors, absent users, wrong accounts and unsafe numeric IDs fail closed', async () => {
  for (const [result, error] of [
    [{ status: 404 }, /TARGET_LOOKUP_HTTP_404/],
    [{ status: 429 }, /TARGET_LOOKUP_HTTP_429/],
    [{ invalidJson: true }, /TARGET_LOOKUP_INVALID_JSON/],
    [{ body: { status: 'fail' } }, /TARGET_LOOKUP_INVALID_USER/],
    [{ body: { data: { user: { id: '123', username: 'someone.else' } } } }, /TARGET_LOOKUP_INVALID_USER/],
    [{ body: { data: { user: { id: 9007199254740992, username: 'example.user' } } } }, /TARGET_LOOKUP_INVALID_USER/],
    [{ body: { data: { user: { id: 'bad', username: 'example.user' } } } }, /TARGET_LOOKUP_INVALID_USER/],
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
