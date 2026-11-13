import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initializeSettings } from '../src/telegram-settings.mjs';
import { applyUpdate } from '../src/telegram-menu.mjs';
import { XWatcher, run } from '../src/x-watch.mjs';
import { XDelivery } from '../src/x-delivery.mjs';

function fixture(t) {
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'x-integration-'));
  t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const root=path.join(base,'downloads'),dir=path.join(base,'control'),stateDir=path.join(base,'state');fs.mkdirSync(root);
  const env={TELEGRAM_CHAT_ID:'100',IG_CONTROL_DIR:dir,IG_STATE_DIR:stateDir,IG_ARCHIVE_DIR:root,X_CHECK_INTERVAL_SECONDS:'60',X_HISTORY_ENABLED:'0'};
  const settings=initializeSettings(env,1000);
  return {base,root,dir,stateDir,env,settings};
}
test('Telegram subscription → Fx fixture → local media → private upload → restart receipts',async t=>{
  const f=fixture(t);
  applyUpdate(f.settings,{update_id:1,message:{from:{id:100},chat:{id:100,type:'private'},text:'/xadd alice'}},1000);
  let current='1',mediaTransfers=0;
  const image=Buffer.alloc(16);image[0]=255;image[1]=216;image[2]=255;
  const fetchImpl=async url=>{
    if(new URL(url).hostname==='pbs.twimg.com'){mediaTransfers++;return new Response(image);}
    return new Response(JSON.stringify({code:200,results:[{type:'status',id:current,author:{screen_name:'alice'},text:'full text',created_timestamp:1700000000,
      media:{all:[{type:'photo',url:`https://pbs.twimg.com/media/${current}.jpg`}]}}]}));
  };
  const watcher=new XWatcher({...f,settings:()=>f.settings,fetchImpl});
  await watcher.cycle(2000);current='2';await watcher.cycle(63000);
  const calls=[];const client={call:async(method,body,options)=>{options.beforeRequest?.();calls.push({method,body,options});return {message_id:calls.length};}};
  const delivery=new XDelivery({...f,settings:()=>f.settings});await delivery.drain(client);
  assert.deepEqual(calls.map(c=>c.method),['sendMessage','sendPhoto']);assert.equal(calls[1].options.files[0].blob.size,16);
  assert.ok(calls.every(c=>c.body.chat_id==='100'));assert.equal(mediaTransfers,2);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root,'x/alice/posts/2.json'))).result.files[0].bytes,16);
  const restarted=new XWatcher({...f,settings:()=>f.settings,fetchImpl});await restarted.cycle(124000);
  await new XDelivery({...f,settings:()=>f.settings}).drain(client);
  assert.equal(calls.length,2);assert.equal(mediaTransfers,2);
});
test('disabled worker publishes a usable heartbeat without a configured bot or account pool',async t=>{
  const f=fixture(t);await run({env:{...f.env,X_ENABLED:'0'},args:['node','x-watch','--once']});
  const health=JSON.parse(fs.readFileSync(path.join(f.stateDir,'x/health.json')));assert.equal(health.enabled,false);assert.equal(health.phase,'disabled');
  await run({env:{IG_STATE_DIR:f.stateDir,IG_TELEGRAM_CONTROL:'0'},args:['node','x-watch','--once']});
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.stateDir,'x/health.json'))).enabled,false);
});
test('real Python child status and exit-code handling work without credentials',async t=>{
  const f=fixture(t);const watcher=new XWatcher({...f,settings:()=>f.settings});
  const result=await watcher.child(['-c','import json; print(json.dumps({"active":0,"locked":0})); raise SystemExit(2)'],{capture:true,allowedCodes:[0,2]});
  assert.deepEqual(JSON.parse(result),{active:0,locked:0});
  await assert.rejects(watcher.child(['-c','raise SystemExit(3)']),/X_HISTORY_PROCESS_FAILED/);
  watcher.env={...f.env,X_HISTORY_ENABLED:'1',X_ACCOUNTS_DB:path.join(f.base,'missing.db')};
  await watcher.refreshPool(Date.now());assert.equal(watcher.state.pool.active,0);assert.equal(fs.existsSync(watcher.env.X_ACCOUNTS_DB),false);
});
test('pool status subprocess never replaces the running history subprocess handle',async t=>{
  const f=fixture(t),watcher=new XWatcher({...f,settings:()=>f.settings});
  const historyHandle={};watcher.childProcess=historyHandle;
  const output=await watcher.child(['-c','print("ready")'],{capture:true,track:false});
  assert.equal(output.trim(),'ready');assert.equal(watcher.childProcess,historyHandle);
});
