import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { XWatcher } from '../src/x-watch.mjs';

const sub = generation => ({generation, joinedAt: 1, notifications: Object.fromEntries(['post','repost','reply','quote'].map(k => [k,{enabled:true,since:1}]))});
const post = id => ({type:'status',id,author:{screen_name:'alice'},text:'hello',created_timestamp:1700000000,url:`https://x.com/alice/status/${id}`});
function fixture(t) {
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'x-watch-')); t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const stateDir=path.join(base,'state'),root=path.join(base,'downloads'); fs.mkdirSync(root);
  const settings={ownerId:'100',allowedIds:['100','200'],users:{100:{xTargets:{alice:sub('one')}},200:{xTargets:{}}},xRequests:{}};
  let payload={code:200,results:[post('1')]},fail=false;
  const fetchImpl=async()=>{if(fail) throw Error('NETWORK'); return new Response(JSON.stringify(payload));};
  const saves=[];
  const archive={save:async event=>{saves.push(event);return {username:'alice',kind:event.kind,contentId:event.statusId,url:event.url,caption:event.text,files:[],errors:[]};}};
  const env={X_CHECK_INTERVAL_SECONDS:'60'};
  const watcher=new XWatcher({stateDir,root,settings:()=>settings,fetchImpl,archive,env});
  return {stateDir,root,settings,watcher,archive,env,fetchImpl,saves,set:v=>payload={code:200,results:v},fail:v=>fail=v};
}
const events = f => fs.existsSync(path.join(f.stateDir,'x/events')) ? fs.readdirSync(path.join(f.stateDir,'x/events')).map(n=>JSON.parse(fs.readFileSync(path.join(f.stateDir,'x/events',n)))) : [];
test('first snapshots and new subscribers are quiet; subsequent discoveries notify only eligible users',async t=>{
  const f=fixture(t);await f.watcher.cycle(1000);
  assert.equal(events(f).filter(e=>e.type==='post').length,0);assert.equal(f.saves.length,1);
  f.settings.users['200'].xTargets.alice=sub('two');f.set([post('2'),post('1')]);await f.watcher.cycle(62000);
  let sent=events(f).filter(e=>e.type==='post');assert.equal(sent.length,1);assert.deepEqual(sent[0].recipients.map(r=>r.userId),['100']);
  f.set([post('3'),post('2')]);await f.watcher.cycle(123000);
  sent=events(f).filter(e=>e.type==='post');assert.equal(sent.length,2);assert.deepEqual(sent[1].recipients.map(r=>r.userId).sort(),['100','200']);
  const restarted=new XWatcher({...f,settings:()=>f.settings});await restarted.cycle(184000);
  assert.equal(events(f).filter(e=>e.type==='post').length,2);
});
test('sustained fetch failures preserve baseline and recover with a durable quiet gap backfill',async t=>{
  const f=fixture(t);await f.watcher.cycle(1700000000000);f.fail(true);await f.watcher.cycle(1700000061000);
  await f.watcher.cycle(1700000121000);await f.watcher.cycle(1700000181000);
  assert.ok(f.watcher.state.accounts.alice.gapStart);
  f.fail(false);f.set(Array.from({length:100},(_,i)=>post(String(i+2))));await f.watcher.cycle(1700004000000);
  assert.ok(Object.values(f.watcher.state.history).some(j=>j.username==='alice'&&j.gap));
  assert.ok(events(f).some(e=>e.type==='notice'&&/恢復/.test(e.text)));
  assert.equal(events(f).filter(e=>e.type==='post').length,0,'recovery snapshots stay quiet');
});
test('same-target history requests share durable queue, revoked requests cannot start work',async t=>{
  const f=fixture(t); f.settings.users['200'].xTargets.alice=sub('two');
  for(const id of ['100','200']) f.settings.xRequests[`${id}-10-0`]={id:`${id}-10-0`,userId:id,type:'history',username:'alice',at:10};
  f.settings.xRequests['999-11-0']={id:'999-11-0',userId:'999',type:'history',username:'alice',at:10};
  f.watcher.syncRequests(1700000000000);
  const jobs=Object.values(f.watcher.state.history);assert.equal(jobs.length,1);assert.equal(jobs[0].requestIds.length,2);
  const restarted=new XWatcher({...f,settings:()=>f.settings});restarted.syncRequests(1700000000000);
  assert.equal(Object.keys(restarted.state.history).length,1);
});
test('archive retries preserve notification intent across restarts and history import does not notify',async t=>{
  const f=fixture(t);await f.watcher.cycle(1000);f.set([post('2')]);
  f.archive.save=async()=>{throw Error('ENOSPC');};await f.watcher.cycle(62000);
  assert.equal(events(f).filter(e=>e.type==='post').length,0);
  f.archive.save=async e=>({username:'alice',contentId:e.statusId,url:e.url,caption:e.text,files:[],errors:[]});
  const restarted=new XWatcher({...f,settings:()=>f.settings});await restarted.cycle(400000);
  assert.equal(events(f).filter(e=>e.type==='post').length,1);
  await restarted.importHistory('alice',[{id:'3',username:'alice',text:'old',date:'2020-01-01T00:00:00Z',media:{images:[]}}],400001);
  assert.equal(events(f).filter(e=>e.type==='post').length,1);
});
test('prototype-looking handles remain own account entries',t=>{
  const f=fixture(t);
  for(const name of ['__proto__','constructor']) {
    const a=f.watcher.account(name);assert.equal(a.baseline,false);assert.ok(a.pending);
    assert.ok(Object.hasOwn(f.watcher.state.accounts,name));
  }
  assert.equal(Object.prototype.baseline,undefined);
});
test('backed-off archive items do not starve later posts or other accounts',async t=>{
  const f=fixture(t),a=f.watcher.account('alice');
  for(let i=1;i<=7;i++)a.pending[`post:${i}`]={event:{statusId:String(i)},at:1,recipients:[],retryAt:i<=5?100000:0};
  await f.watcher.archivePending(1000);
  assert.deepEqual(f.saves.map(e=>e.statusId),['6','7']);
});
test('history runner completes metadata import quietly and shared requests see result',async t=>{
  const f=fixture(t);const id='100-1-0';
  f.settings.xRequests[id]={id,userId:'100',username:'alice',type:'history',at:1};
  f.watcher.env={...f.env,X_HISTORY_ENABLED:'1'};
  f.watcher.historyRunner=async(job,{out})=>{
    fs.writeFileSync(path.join(out,'alice_posts.jsonl'),JSON.stringify({id:'99',username:'alice',text:'archive',date:'2020-01-01T00:00:00Z',media:{images:[]}})+'\n');
    return {status:'partial',start:'2020-01-01'};
  };
  f.watcher.syncRequests(1700000000000);f.watcher.startNextHistory(1700000000000);
  await f.watcher.historyTask;
  const job=Object.values(f.watcher.state.history)[0];assert.equal(job.status,'partial');assert.equal(job.posts,1);
  await f.watcher.archivePending(1700000000001);
  f.watcher.child=async()=>{};
  await f.watcher.finishHistories();
  assert.ok(fs.existsSync(path.join(f.root,'x/alice/media_manifest.json')));
  assert.ok(events(f).some(e=>e.type==='notice'&&/部分完成/.test(e.text)));
  assert.equal(events(f).filter(e=>e.type==='post').length,0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.stateDir,'x/jobs',id+'.json'))).status,'partial');
});
test('missing start date is actionable and failed history retries without losing queue',async t=>{
  const f=fixture(t);f.watcher.env={...f.env,X_HISTORY_ENABLED:'1'};
  f.watcher.enqueueHistory({username:'alice',userId:'100'},1000);
  f.watcher.historyRunner=async()=>({status:'needs_start',reason:'X_START_DATE_REQUIRED'});
  f.watcher.startNextHistory(1000);await f.watcher.historyTask;await f.watcher.finishHistories();
  assert.equal(Object.values(f.watcher.state.history)[0].status,'needs_start');
  assert.ok(events(f).some(e=>/指定起日/.test(e.text)));
  const retry=f.watcher.enqueueHistory({username:'alice',userId:'100',start:'2020-01-01'},2000);
  f.watcher.historyRunner=async()=>{throw Error('X_NO_ACCOUNT_AVAILABLE');};
  f.watcher.startNextHistory(2000);await f.watcher.historyTask;
  assert.equal(retry.status,'retry');assert.equal(retry.attempts,0,'pool rate locks do not consume the failure budget');
  assert.equal(events(f).filter(e=>/歷史回補暫停/.test(e.text||'')).length,0);
});
test('container downtime uses the normal timeline when it covers the gap',async t=>{
  const f=fixture(t);await f.watcher.cycle(1700000000000);f.set([post('2')]);
  const restarted=new XWatcher({...f,settings:()=>f.settings});await restarted.cycle(1700010000000);
  assert.equal(Object.values(restarted.state.history).filter(j=>j.gap).length,0);
  assert.equal(events(f).filter(e=>e.type==='post').length,0);
});
test('removing the last authorized requester cancels a running history before further import',async t=>{
  const f=fixture(t);f.watcher.env={...f.env,X_HISTORY_ENABLED:'1'};
  const job=f.watcher.enqueueHistory({username:'alice',userId:'100'},1700000000000);
  let finish;f.watcher.historyRunner=()=>new Promise(resolve=>{finish=resolve;});
  f.watcher.startNextHistory(1700000000000);
  f.settings.users['100'].xTargets={};
  await f.watcher.cycle(1700000000001);finish({status:'complete'});await f.watcher.historyTask;
  assert.equal(job.status,'cancelled');assert.equal(Object.keys(f.watcher.account('alice').pending).length,0);
});
test('manual post download produces a durable requester-only event independent of subscriptions',async t=>{
  const f=fixture(t);const id='200-8-0';
  f.settings.xRequests[id]={id,userId:'200',type:'manual',username:'alice',url:'https://x.com/alice/status/8',at:100};
  f.watcher.fetchImpl=async()=>new Response(JSON.stringify({code:200,tweet:post('8')}));
  f.watcher.syncRequests(1000);await f.watcher.manualRequests(1000);
  const e=events(f).find(e=>e.manual);assert.equal(e.requestId,id);assert.deepEqual(e.recipients,[{userId:'200'}]);
  assert.equal(f.watcher.state.requests[id].status,'complete');
});
test('pool counts refresh during historical work and retries wait for the actual unlock',async t=>{
  const f=fixture(t),now=1700000000000,unlock=now+720000;
  f.watcher.env={...f.env,X_HISTORY_ENABLED:'1'};
  f.watcher.historyTask=Promise.resolve();
  const job=f.watcher.enqueueHistory({username:'alice',userId:'100',requestId:'100-1-0'},now);
  job.status='retry';job.reason='X_NO_ACCOUNT_AVAILABLE';job.retryAt=now+300000;
  let reads=0;
  f.watcher.child=async(_args,options)=>{reads++;assert.equal(options.track,false);return JSON.stringify({active:3,locked:3,available:0,nextAvailableAt:unlock});};
  await f.watcher.refreshPool(now);
  assert.equal(reads,1);assert.equal(f.watcher.state.pool.available,0);assert.equal(f.watcher.state.pool.locked,3);
  assert.equal(job.retryAt,unlock+1000);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.stateDir,'x/jobs/100-1-0.json'))).retryAt,unlock+1000);
  assert.equal(f.watcher.state.pool.checkedAt,now);
  await f.watcher.refreshPool(now+31000);assert.equal(reads,2,'pool count cache is at most 30 seconds');
  f.watcher.child=async()=>JSON.stringify({active:3,locked:0,available:3,nextAvailableAt:null});
  await f.watcher.refreshPool(now+62000);
  assert.equal(job.retryAt,now+62000,'restored usable accounts resume a rate-limited job immediately');
});
test('a known fully locked pool waits without starting another scraper process',t=>{
  const f=fixture(t),now=1700000000000,unlock=now+600000;
  f.watcher.env={...f.env,X_HISTORY_ENABLED:'1'};
  f.watcher.state.pool={active:3,locked:3,available:0,nextAvailableAt:unlock,checkedAt:now};
  const job=f.watcher.enqueueHistory({username:'alice',userId:'100'},now);
  f.watcher.historyRunner=()=>assert.fail('must honor the saved rate limit');
  f.watcher.startNextHistory(now);
  assert.equal(f.watcher.historyTask,undefined);assert.equal(job.status,'retry');assert.equal(job.retryAt,unlock+1000);
});
test('history reports retain detailed progress and omit private fields',t=>{
  const f=fixture(t),job=f.watcher.enqueueHistory({username:'alice',userId:'100',requestId:'100-1-0'},1700000000000);
  job.status='working';
  const progress={stage:'search',lastWorkStage:'search',start:'2017-09-19',end:'2026-11-13',posts:10052,at:1700000000100,
    totalWindows:1196,completedWindows:983,remainingWindows:213,currentPass:'search_verify',windowStart:'2022-10-01',windowEnd:'2022-10-08',
    passes:[{name:'search_verify',total:478,completed:265,partial:0,failed:0}],cookies:'must-not-leak'};
  fs.mkdirSync(path.join(f.stateDir,'x/progress'),{recursive:true});fs.writeFileSync(path.join(f.stateDir,'x/progress',job.id+'.json'),JSON.stringify(progress));
  const report=f.watcher.historyReport(job,1700000000200);
  assert.equal(report.phase,'search');assert.equal(report.start,'2017-09-19');assert.equal(report.progress.totalWindows,1196);
  assert.equal(report.progress.currentPass,'search_verify');assert.equal(report.progress.windowStart,'2022-10-01');assert.equal(report.progressUpdatedAt,progress.at);
  assert.equal(report.requestedAt,job.at);assert.equal(report.posts,10052);
  assert.equal(JSON.stringify(report).includes('must-not-leak'),false);assert.equal(Object.hasOwn(report,'userIds'),false);
  const health=f.watcher.health(1700000000200);assert.equal(health.historyJobs[0].id,job.id);
});
test('history archival progress counts posts independently of search completion',async t=>{
  const f=fixture(t);await f.watcher.cycle(1000);
  const job=f.watcher.enqueueHistory({username:'alice',userId:'100'},1700000000000);job.status='importing';
  const records=['1','2'].map(id=>({id,username:'alice',text:'saved',date:'2020-01-01T00:00:00Z',media:{images:[]}}));
  await f.watcher.importHistory('alice',records,2000,()=>true,job);job.fetchDone=true;job.status='complete';
  let report=f.watcher.historyReport(job,3000);assert.equal(report.phase,'archive');
  assert.deepEqual(report.archive,{total:2,done:1,remaining:1,failed:0,unit:'post'});assert.equal(report.importedPosts,2);
  await f.watcher.archivePending(4000);report=f.watcher.historyReport(job,5000);assert.equal(report.archive.done,2);
  f.watcher.account('alice').seen['post:999']=4000;
  f.watcher.account('alice').pending['post:999']={event:{statusId:'999'},at:4000,recipients:[],failed:true,retryAt:99999999};
  await f.watcher.finishHistories();
  assert.equal(job.reported,true,'unrelated daily retry must not block this completed historical batch');
  assert.equal(f.watcher.historyReport(job,6000).phase,'finished');
});
test('legacy active history progress can rebuild membership without fetching or downloading',async t=>{
  const f=fixture(t);await f.watcher.cycle(1000);
  const job=f.watcher.enqueueHistory({username:'alice',userId:'100'},1700000000000);job.fetchDone=true;job.status='complete';
  const records=[{id:'1',username:'alice',text:'old',date:'2020-01-01T00:00:00Z',media:{images:[]}}];
  const dir=f.watcher.historyDirectory('alice');fs.writeFileSync(path.join(dir,'alice_posts.jsonl'),JSON.stringify(records[0])+'\n');
  await f.watcher.hydrateArchiveProgress();
  assert.equal(f.saves.length,1);assert.equal(job.archiveKeys.length,1);assert.equal(f.watcher.historyReport(job).archive.done,1);
});

test('new manual requests explicitly save into the manual namespace', async t => {
  const f=fixture(t),id='200-8-0'; let options;
  f.settings.xRequests[id]={id,userId:'200',type:'manual',username:'alice',url:'https://x.com/alice/status/8',at:100};
  f.archive.save=async (event,opts)=>{options=opts;return{username:'alice',kind:event.kind,contentId:event.statusId,url:event.url,caption:event.text,files:[],errors:[]};};
  f.watcher.fetchImpl=async()=>new Response(JSON.stringify({code:200,tweet:post('8')}));
  f.watcher.syncRequests(1000);await f.watcher.manualRequests(1000);
  assert.deepEqual(options,{manual:true});
});

test('legacy completed manual requests retain their identified archive without replaying events', async t => {
  const f=fixture(t),id='200-8-0';let retained=0;
  f.settings.xRequests[id]={id,userId:'200',type:'manual',username:'alice',url:'https://x.com/alice/status/8',at:100};
  f.watcher.state.requests[id]={status:'complete',attempts:1};
  const result={username:'alice',kind:'post',contentId:'8',url:'https://x.com/alice/status/8',caption:'old',files:[],errors:[]};
  f.watcher.emit({type:'post',username:'alice',kind:'post',statusId:'8',at:100,manual:true,requestId:id,userId:'200',recipients:[{userId:'200'}],result},`manual:${id}`);
  const original=events(f).find(e=>e.manual);
  f.archive.retainManual=async saved=>{retained++;assert.deepEqual(saved,result);return saved;};
  f.settings.allowedIds=[]; // Archival retention is independent of current delivery authorization.
  await f.watcher.manualRequests(1000);await f.watcher.manualRequests(2000);
  assert.equal(retained,1);assert.deepEqual(events(f).find(e=>e.manual),original);
  assert.equal(f.watcher.state.requests[id].status,'complete');
  assert.equal(f.watcher.state.requests[id].manualArchiveVersion,1);
});

test('legacy manual requests without trustworthy events remain unchanged with a migration reason', async t => {
  const f=fixture(t),id='200-8-0';
  f.settings.xRequests[id]={id,userId:'200',type:'manual',username:'alice',url:'https://x.com/alice/status/8',at:100};
  f.watcher.state.requests[id]={status:'complete',attempts:1};
  f.archive.retainManual=async()=>assert.fail('no reliable source event');
  await f.watcher.manualRequests(1000);
  assert.equal(f.watcher.state.requests[id].status,'complete');
  assert.equal(f.watcher.state.requests[id].manualArchiveReason,'X_MANUAL_MIGRATION_EVENT_MISSING');
});

test('404 stays healthy until three consecutive polls, persists and resets on success',async t=>{
  const f=fixture(t);let missing=false;
  f.watcher.fetchImpl=async()=>new Response(JSON.stringify(missing?{code:404,results:[]}:{code:200,results:[post('1')]}),{status:missing?404:200});
  await f.watcher.pollAccount('alice',1000);missing=true;
  await f.watcher.pollAccount('alice',61000);
  await f.watcher.pollAccount('alice',121000);
  let a=f.watcher.account('alice');assert.equal(a.failures,0);assert.equal(a.consecutive404,2);assert.equal(a.nextAt,181000);
  assert.equal(events(f).filter(e=>e.type==='notice').length,0);
  const restarted=new XWatcher({...f,settings:()=>f.settings});
  restarted.fetchImpl=f.watcher.fetchImpl;
  await restarted.pollAccount('alice',181000);a=restarted.account('alice');
  assert.equal(a.failures,1);assert.equal(a.consecutive404,3);
  assert.equal(events(f).filter(e=>e.type==='notice'&&/監控異常/.test(e.text)).length,1);
  missing=false;await restarted.pollAccount('alice',a.nextAt);
  assert.equal(a.failures,0);assert.equal(a.consecutive404,0);
  missing=true;await restarted.pollAccount('alice',a.nextAt);
  assert.equal(a.failures,0);assert.equal(a.consecutive404,1);
});
test('a tolerated 404 does not hide a later downtime gap',async t=>{
  const f=fixture(t);await f.watcher.pollAccount('alice',1700000000000);
  f.watcher.fetchImpl=async()=>new Response('{}',{status:404});
  await f.watcher.pollAccount('alice',1700000060000);
  f.watcher.fetchImpl=f.fetchImpl;
  await f.watcher.pollAccount('alice',1700100000000);
  assert.equal(Object.values(f.watcher.state.history).length,0);
});

for(const status of [500,502,503,429,'network'])test(`${status} waits for three consecutive failures across restarts`,async t=>{
  const f=fixture(t);await f.watcher.pollAccount('alice',1000);
  const fail=async()=>{if(status==='network')throw Error('offline');return new Response('{}',{status});};
  f.watcher.fetchImpl=fail;
  await f.watcher.pollAccount('alice',61000);await f.watcher.pollAccount('alice',121000);
  assert.equal(f.watcher.account('alice').failures,0);assert.equal(events(f).length,0);
  const restarted=new XWatcher({...f,settings:()=>f.settings,fetchImpl:fail});
  await restarted.pollAccount('alice',181000);
  assert.equal(restarted.account('alice').failures,1);assert.equal(events(f).filter(e=>/監控異常/.test(e.text)).length,1);
});
test('short transient failures recover silently and reset the streak',async t=>{
  const f=fixture(t);await f.watcher.pollAccount('alice',1000);
  f.watcher.fetchImpl=async()=>new Response('{}',{status:500});
  await f.watcher.pollAccount('alice',61000);await f.watcher.pollAccount('alice',121000);
  f.watcher.fetchImpl=f.fetchImpl;await f.watcher.pollAccount('alice',181000);
  assert.equal(events(f).length,0);assert.equal(Object.keys(f.watcher.state.history).length,0);
  f.watcher.fetchImpl=async()=>new Response('{}',{status:500});await f.watcher.pollAccount('alice',241000);
  assert.equal(f.watcher.account('alice').failures,0);
});
test('history transient failures retry quietly six times and notify only at exhaustion',async t=>{
  const f=fixture(t);f.watcher.env={...f.env,X_HISTORY_ENABLED:'1'};
  const job=f.watcher.enqueueHistory({username:'alice',userId:'100'},1000);
  f.watcher.historyRunner=async()=>{throw Error('X_NETWORK_ERROR');};
  for(let i=1;i<=6;i++){
    f.watcher.startNextHistory(i===1?1000:job.retryAt);await f.watcher.historyTask;
    assert.equal(job.status,i<6?'retry':'failed');
    assert.equal(events(f).filter(e=>/歷史回補(?:暫停|失敗)/.test(e.text)).length,i<6?0:1);
  }
});
test('archive transient failures wait three attempts and share one alert per target',async t=>{
  const f=fixture(t),a=f.watcher.account('alice');
  for(const id of ['2','3'])a.pending[`post:${id}`]={event:{statusId:id},at:1,recipients:[]};
  f.archive.save=async()=>{throw Error('X_MEDIA_DOWNLOAD_INCOMPLETE');};
  for(let i=0;i<3;i++){
    await f.watcher.archivePending(1000+i*300000);
    assert.equal(events(f).filter(e=>/封存失敗/.test(e.text)).length,i<2?0:1);
  }
  f.archive.save=async()=>({errors:[]});await f.watcher.archivePending(901000);
  assert.equal(events(f).filter(e=>/封存已恢復/.test(e.text)).length,1);
});
test('temporary pool read errors do not notify before three failed checks',async t=>{
  const f=fixture(t);f.watcher.env={...f.env,X_HISTORY_ENABLED:'1'};
  f.watcher.child=async()=>{throw Error('X_HISTORY_PROCESS_FAILED');};
  await f.watcher.refreshPool(1000);await f.watcher.refreshPool(31000);
  assert.equal(events(f).length,0);
  await f.watcher.refreshPool(61000);assert.equal(events(f).length,1);
});

test('alternating recoverable errors share a consecutive failure streak',async t=>{
  const f=fixture(t);await f.watcher.pollAccount('alice',1000);
  for(const [i,status] of [404,500,502].entries()){
    f.watcher.fetchImpl=async()=>new Response('{}',{status});await f.watcher.pollAccount('alice',61000+i*60000);
    assert.equal(f.watcher.account('alice').failures,i<2?0:1);
  }
  assert.equal(events(f).filter(e=>/監控異常/.test(e.text)).length,1);
});
test('manual transient errors get six attempts and keep the requester informed only at exhaustion',async t=>{
  const f=fixture(t),id='200-8-0';
  f.settings.xRequests[id]={id,userId:'200',type:'manual',username:'alice',url:'https://x.com/alice/status/8',at:100};
  f.watcher.fetchImpl=async()=>new Response('{}',{status:500});f.watcher.syncRequests(1000);
  for(let i=1;i<=6;i++){
    await f.watcher.manualRequests(1000+(i-1)*30000);
    assert.equal(f.watcher.state.requests[id].status,i<6?'retry':'failed');
    assert.equal(events(f).length,i<6?0:1);
  }
  assert.deepEqual(events(f)[0].recipients,[{userId:'200'}]);
});
test('persistent empty pools alert once and send one recovery',async t=>{
  const f=fixture(t);f.watcher.env={...f.env,X_HISTORY_ENABLED:'1'};
  f.watcher.child=async()=>JSON.stringify({active:0,locked:0});
  for(let i=0;i<4;i++){
    await f.watcher.refreshPool(1000+i*30000);assert.equal(events(f).length,i<2?0:1);
  }
  f.watcher.child=async()=>JSON.stringify({active:1,locked:0});
  await f.watcher.refreshPool(121000);await f.watcher.refreshPool(151000);
  assert.equal(events(f).length,2);
});
test('automatic gap backfill start and success are silent',async t=>{
  const f=fixture(t);f.watcher.env={...f.env,X_HISTORY_ENABLED:'1'};
  const job=f.watcher.enqueueHistory({username:'alice',userId:'100',gap:true},1000);
  f.watcher.historyRunner=async(_job,{out})=>{
    fs.writeFileSync(path.join(out,'alice_posts.jsonl'),'');return {status:'complete'};
  };
  f.watcher.child=async()=>{};
  f.watcher.startNextHistory(1000);await f.watcher.historyTask;await f.watcher.finishHistories();
  assert.equal(job.reported,true);assert.equal(events(f).length,0);
});
test('disk full still alerts immediately while downloads remain queued',async t=>{
  const f=fixture(t),a=f.watcher.account('alice');
  a.pending['post:2']={event:{statusId:'2'},at:1,recipients:[]};
  f.archive.save=async()=>{throw Error('ENOSPC');};await f.watcher.archivePending(1000);
  assert.equal(events(f).length,1);assert.equal(a.pending['post:2'].failed,true);
});

for(const gapFirst of [true,false])test(`explicit history merged with gap retains completion notice (gapFirst=${gapFirst})`,async t=>{
  const f=fixture(t);f.watcher.env={...f.env,X_HISTORY_ENABLED:'1'};
  const background={username:'alice',userId:'100',gap:true};
  const explicit={username:'alice',userId:'100',requestId:'100-1-0'};
  const job=f.watcher.enqueueHistory(gapFirst?background:explicit,1000);
  assert.equal(f.watcher.enqueueHistory(gapFirst?explicit:background,1000),job);
  f.watcher.historyRunner=async(_job,{out})=>{fs.writeFileSync(path.join(out,'alice_posts.jsonl'),'');return {status:'complete'};};
  f.watcher.child=async()=>{};
  f.watcher.startNextHistory(1000);await f.watcher.historyTask;await f.watcher.finishHistories();
  assert.equal(events(f).filter(e=>/歷史回補已開始/.test(e.text)).length,1);
  assert.equal(events(f).filter(e=>/搜尋流程已完成/.test(e.text)).length,1);
});
test('real history worker timeout responses get six quiet attempts',async t=>{
  const f=fixture(t);f.watcher.env={...f.env,X_HISTORY_ENABLED:'1'};
  const job=f.watcher.enqueueHistory({username:'alice',userId:'100'},1000);
  f.watcher.historyRunner=async()=>({status:'failed',reason:'X_HISTORY_TIMEOUT'});
  for(let i=1;i<=6;i++){
    f.watcher.startNextHistory(i===1?1000:job.retryAt);await f.watcher.historyTask;
    assert.equal(job.status,i<6?'retry':'failed');
    assert.equal(events(f).filter(e=>/歷史回補失敗/.test(e.text)).length,i<6?0:1);
  }
});


test('a full recovery timeline reconnects to the saved checkpoint across restart', async t=>{
  const f=fixture(t),now=1700000000000;
  await f.watcher.pollAccount('alice',now);
  f.set([...Array.from({length:99},(_,i)=>post(String(i+2))),post('1')]);
  const restarted=new XWatcher({...f,settings:()=>f.settings});
  await restarted.pollAccount('alice',now+3600000);
  assert.equal(Object.keys(restarted.state.history).length,0);
  assert.equal(Object.keys(restarted.account('alice').pending).length,100);
});

test('legacy automatic queued gaps are rechecked but explicit requests are preserved',async t=>{
  const f=fixture(t),now=1700000000000;
  await f.watcher.pollAccount('alice',now);
  const auto=f.watcher.enqueueHistory({username:'alice',start:'2023-11-14',end:'2023-11-15',gap:true},now);
  auto.status='retry';auto.reason='X_NO_ACCOUNT_AVAILABLE';
  const explicit=f.watcher.enqueueHistory({username:'alice',userId:'100',requestId:'100-1-0',start:'2020-01-01'},now);
  f.set([post('2'),post('1')]);await f.watcher.pollAccount('alice',now+60000);
  assert.equal(auto.status,'cancelled');
  assert.equal(auto.reason,'X_GAP_COVERED_BY_TIMELINE');
  assert.equal(explicit.status,'queued');
});

test('uncovered gaps merge only pending automatic work and retain the earliest checkpoint',async t=>{
  const f=fixture(t),now=1700000000000;
  await f.watcher.pollAccount('alice',now);
  f.set(Array.from({length:100},(_,i)=>post(String(i+2))));
  await f.watcher.pollAccount('alice',now+86400000);
  const job=Object.values(f.watcher.state.history)[0];
  f.set(Array.from({length:100},(_,i)=>post(String(i+102))));
  await f.watcher.pollAccount('alice',now+172800000);
  assert.equal(Object.keys(f.watcher.state.history).length,1);
  assert.equal(job.start,'2023-11-14');assert.equal(job.end,'2023-11-17');
  assert.equal(job.gapSince,now);
});

test('empty timelines cannot silently discard a gap',async t=>{
  const f=fixture(t),now=1700000000000;await f.watcher.pollAccount('alice',now);
  f.set([]);await f.watcher.pollAccount('alice',now+3600000);
  assert.equal(Object.values(f.watcher.state.history).filter(j=>j.gap).length,1);
});

test('multiple legacy automatic queues consolidate without widening a running search',async t=>{
  const f=fixture(t),now=1700000000000;
  const first=f.watcher.enqueueHistory({username:'alice',start:'2023-11-10',end:'2023-11-11',gap:true},now);
  const second=f.watcher.enqueueHistory({username:'alice',start:'2023-11-12',end:'2023-11-13',gap:true},now+1);
  const running=f.watcher.enqueueHistory({username:'alice',start:'2023-11-09',end:'2023-11-10',gap:true},now+2);
  running.status='working';
  f.set(Array.from({length:100},(_,i)=>post(String(i+2))));
  await f.watcher.pollAccount('alice',now+3);
  assert.equal(first.start,'2023-11-10');assert.equal(first.end,'2023-11-13');
  assert.equal(second.status,'cancelled');assert.equal(second.reason,'X_GAP_MERGED');
  assert.equal(running.status,'working');assert.equal(running.end,'2023-11-10');
});

test('live notifications bypass history backlog while reserving history progress',async t=>{
  const f=fixture(t),a=f.watcher.account('alice');
  for(let i=1;i<=10;i++)a.pending[`post:${i}`]={event:{statusId:String(i)},at:1,recipients:[]};
  for(let i=11;i<=16;i++)a.pending[`post:${i}`]={event:{statusId:String(i)},at:2,recipients:[{userId:'100',generation:'one'}]};
  await f.watcher.archivePending(1000);
  assert.deepEqual(f.saves.map(e=>e.statusId),['11','12','13','14','1']);
  assert.equal(events(f).filter(e=>e.type==='post').length,4);
  await f.watcher.archivePending(2000);
  assert.deepEqual(f.saves.slice(5).map(e=>e.statusId),['15','16','2','3','4']);
});
test('backed-off live notifications do not block eligible live or history work',async t=>{
  const f=fixture(t),a=f.watcher.account('alice');
  a.pending['post:1']={event:{statusId:'1'},at:1,recipients:[{userId:'100'}],retryAt:10000};
  a.pending['post:2']={event:{statusId:'2'},at:2,recipients:[]};
  a.pending['post:3']={event:{statusId:'3'},at:3,recipients:[{userId:'100'}]};
  await f.watcher.archivePending(1000);
  assert.deepEqual(f.saves.map(e=>e.statusId),['3','2']);
});
