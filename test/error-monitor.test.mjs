import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Issues } from '../src/error-monitor.mjs';

function fixture(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ig-issues-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'issues.json'),outbox=path.join(dir,'outbox');
  return {restart:()=>new Issues(file,outbox,'@alice'),events:()=>fs.existsSync(outbox)?fs.readdirSync(outbox).map(f=>JSON.parse(fs.readFileSync(path.join(outbox,f)))):[]};
}
for(const [key,reason] of [['fetch','FETCH_TIMEOUT'],['catalog-fetch:posts','CATALOG_BOOTSTRAP_HTTP_503'],['archive:1','NAS_HTTP_404'],['media:1','TELEGRAM_HTTP_429'],['catalog-caption:1','NAS_DOWNLOAD_NETWORK_OR_IO_ERROR']]) {
  test(`${key} waits three consecutive failures, survives restart and deduplicates reason changes`,t=>{
    const f=fixture(t);let issues=f.restart();
    issues.fail(key,reason);assert.equal(issues.activeCount(),0);assert.equal(f.events().length,0);
    issues=f.restart();issues.fail(key,reason);assert.equal(f.events().length,0);
    issues.fail(key,reason);assert.equal(issues.activeCount(),1);assert.equal(f.events().length,1);
    issues.fail(key,'FETCH_TIMEOUT');assert.equal(f.events().length,1);
    issues.resolve(key);assert.equal(f.events().length,2);assert.equal(issues.activeCount(),0);
    issues.fail(key,reason);assert.equal(f.events().length,2);assert.equal(issues.activeCount(),0);
  });
}
test('two failures followed by success reset silently and keep targets independent',t=>{
  const f=fixture(t),issues=f.restart();
  issues.fail('target:alice:fetch','FETCH_TIMEOUT');issues.fail('target:alice:fetch','FETCH_TIMEOUT');
  issues.fail('target:bob:fetch','FETCH_TIMEOUT');issues.resolve('target:alice:fetch');
  issues.fail('target:alice:fetch','FETCH_TIMEOUT');issues.fail('target:bob:fetch','FETCH_TIMEOUT');
  assert.equal(f.events().length,0);assert.equal(issues.state['target:alice:fetch'].count,1);
  issues.fail('target:bob:fetch','FETCH_TIMEOUT');assert.equal(f.events().length,1);
});
test('session, storage and integrity issues still alert immediately',t=>{
  const f=fixture(t),issues=f.restart();
  for(const [key,reason] of [['shared-session','SESSION_INVALID_RELOGIN_REQUIRED'],['nas-storage','NAS_ENOSPC'],['catalog-fetch:posts','CATALOG_UNTRUSTED_RESULT']])issues.fail(key,reason);
  assert.equal(issues.activeCount(),3);assert.equal(f.events().length,3);
});

test('cooldown waits do not consume the failure budget and removed targets reset pending streaks',t=>{
  const f=fixture(t),issues=f.restart(),key='target:alice:media:1';
  issues.fail(key,'TELEGRAM_HTTP_429');
  for(let i=0;i<10;i++)issues.fail(key,'TELEGRAM_RETRY_WAIT');
  assert.equal(issues.state[key].count,1);assert.equal(f.events().length,0);
  issues.suspendAccount('alice');issues.fail(key,'TELEGRAM_HTTP_429');
  assert.equal(issues.state[key].count,1);assert.equal(f.events().length,0);
});
test('transient malformed upstream responses wait but later critical errors escalate immediately',t=>{
  const f=fixture(t),issues=f.restart();
  issues.fail('catalog-fetch:posts','CATALOG_INVALID_POST');
  issues.fail('catalog-fetch:posts','CATALOG_INVALID_POST');assert.equal(f.events().length,0);
  issues.fail('catalog-fetch:posts','CATALOG_SESSION_INVALID');assert.equal(f.events().length,1);
});

test('real Telegram authentication codes and bootstrap diagnostics escalate immediately',t=>{
  const f=fixture(t),issues=f.restart();
  issues.fail('media:1','TELEGRAM_ERROR_401');
  issues.fail('fetch','BOOTSTRAP_HTTP_ERROR:http=403:exit=4');
  assert.equal(issues.activeCount(),2);assert.equal(f.events().length,2);
});

test('local catalog state integrity failures remain immediate',t=>{
  const f=fixture(t),issues=f.restart();
  for(const reason of ['CATALOG_INVALID_ASSET_HISTORY','CATALOG_INVALID_CAPTION_HISTORY','ARCHIVE_LAYOUT_INVALID_STATE'])issues.fail('target:alice:target-runtime',reason);
  assert.equal(f.events().length,3);
});

test('read-receipt guard invariant failures always alert immediately',t=>{
  const f=fixture(t),issues=f.restart();
  for(const [key,reason] of [['fetch','CRITICAL_GUARD_INVARIANT_FAILURE:exit=10'],['catalog-fetch:posts','CATALOG_GUARD_INVARIANT_FAILED'],['fetch','TARGET_GUARD_INVARIANT_FAILED']])issues.fail(key,reason);
  assert.equal(f.events().length,3);
});
