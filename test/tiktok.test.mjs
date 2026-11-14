import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initializeSettings } from '../src/telegram-settings.mjs';
import { applyUpdate } from '../src/telegram-menu.mjs';
import { TikTokDelivery } from '../src/tiktok-delivery.mjs';
import { telegramApiBase, telegramFileLimit } from '../src/telegram-endpoint.mjs';
import { TelegramClient } from '../src/telegram-client.mjs';
import { atomic } from '../src/error-monitor.mjs';
const msg = (n, id, text) => ({ update_id: n, message: { from: { id }, chat: { id, type: 'private' }, text } });
const cb = (n, id, data) => ({ update_id: n, callback_query: { id: ''+n, from: { id }, message: { chat: { id, type: 'private' } }, data } });
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'control'), stateDir = path.join(root, 'state');
  const env = { TELEGRAM_CHAT_ID: '100', TELEGRAM_ALLOWED_USER_IDS: '200', IG_CONTROL_DIR: dir };
  const settings = initializeSettings(env, 1000);
  return { root, dir, stateDir, env, settings };
}
test('TikTok subscriptions are isolated, seeded once, generations reject stale buttons', t => {
  const f = fixture(t), s = f.settings;
  assert.deepEqual(s.users['100'].tiktokTargets, {});
  applyUpdate(s, msg(1, 999, '/ttadd alice'), 2000);
  assert.equal(s.users['100'].tiktokTargets.alice, undefined);
  applyUpdate(s, msg(2, 100, '/ttadd alice'), 2000);
  applyUpdate(s, msg(3, 200, '/ttadd alice'), 2000);
  const sub = s.users['100'].tiktokTargets.alice, gen = sub.generation.slice(0,8);
  applyUpdate(s, cb(4, 100, `tt:set:alice:video:0:${gen}`), 2100);
  assert.equal(sub.notifications.video.enabled, false);
  assert.equal(s.users['200'].tiktokTargets.alice.notifications.video.enabled, true);
  applyUpdate(s, cb(5, 100, `tt:delete:alice:${gen}`));
  applyUpdate(s, msg(6, 100, '/ttadd alice'), 2200);
  applyUpdate(s, cb(7, 100, `tt:delete:alice:${gen}`));
  assert.ok(s.users['100'].tiktokTargets.alice);
  delete s.users['100'].tiktokTargets.alice;
  atomic(path.join(f.dir, 'settings.json'), s);
  assert.equal(initializeSettings({ ...f.env, TIKTOK_TARGET_USERNAMES: 'alice' }).users['100'].tiktokTargets.alice, undefined);
});
test('Local API endpoint and upload size are configurable; credentials in endpoint rejected', async t => {
  const f = fixture(t);
  assert.equal(telegramFileLimit({}), 50_000_000);
  assert.equal(telegramFileLimit({ TELEGRAM_BOT_API_URL: 'http://telegram-bot-api:8081' }), 2_000_000_000);
  assert.throws(() => telegramApiBase({ TELEGRAM_BOT_API_URL: 'http://user:pass@host' }));
  let url;
  const client = new TelegramClient({ token: '123:abc', dir: f.dir, baseUrl: 'http://local:8081', fetchImpl: async u => { url = u; return { ok:true, json:async()=>({ok:true,result:[]}) }; } });
  await client.call('getUpdates', {}, { polling:true });
  assert.equal(url, 'http://local:8081/bot123:abc/getUpdates');
});
test('TikTok events share one local file, receipts persist, revoked users and old events are suppressed', async t => {
  const f = fixture(t), s = f.settings;
  applyUpdate(s, msg(1, 100, '/ttadd alice'), 1000);
  applyUpdate(s, msg(2, 200, '/ttadd alice'), 1000);
  const relative = 'tiktok/alice/live/test.mp4';
  fs.mkdirSync(path.dirname(path.join(f.root,relative)), { recursive:true });
  fs.writeFileSync(path.join(f.root,relative), Buffer.alloc(4096));
  const event = { username:'alice', kind:'video', at:2000, text:'complete', files:[relative], recipients:['100','200'].map(userId=>({userId,generation:s.users[userId].tiktokTargets.alice.generation})) };
  const eventFile = path.join(f.stateDir,'tiktok/events', 'a'.repeat(64)+'.json'); atomic(eventFile,event);
  const calls=[], client={ call:async(method,body,opts)=>{opts?.beforeRequest?.(); calls.push([method,body]); return {message_id:calls.length};} };
  s.allowedIds=['100'];
  const delivery = new TikTokDelivery({...f,settings:()=>s});
  assert.equal(await delivery.drain(client),true);
  assert.equal(calls.length,2);
  assert.ok(calls[1][1].video.startsWith('file://'));
  assert.equal(calls[1][1].chat_id,'100');
  const restarted = new TikTokDelivery({...f,settings:()=>s});
  atomic(eventFile,event); await restarted.drain(client);
  assert.equal(calls.length,2);
  assert.ok(fs.existsSync(path.join(f.root,relative)));
});
test('missing/corrupt TikTok events do not crash shared controller; disabled notifications cancel pending videos', async t => {
  const f=fixture(t), s=f.settings;
  applyUpdate(s,msg(1,100,'/ttadd alice'),1000);
  const event={username:'alice',kind:'video',at:2000,text:'complete',files:['tiktok/alice/live/missing.mp4'],recipients:[{userId:'100',generation:s.users['100'].tiktokTargets.alice.generation}]};
  atomic(path.join(f.stateDir,'tiktok/events','b'.repeat(64)+'.json'),event);
  const delivery=new TikTokDelivery({...f,settings:()=>s});
  const client={call:async(_m,_b,o)=>{o.beforeRequest?.();return{message_id:1};}};
  assert.equal(await delivery.drain(client),false);
  s.users['100'].tiktokTargets.alice.notifications.video.enabled=false;
  assert.equal(await delivery.drain(client),true);
});
test('notice lane can send LIVE start while video upload remains pending', async t => {
  const f=fixture(t),s=f.settings;
  applyUpdate(s,msg(1,100,'/ttadd alice'),1000);
  const recipients=[{userId:'100',generation:s.users['100'].tiktokTargets.alice.generation}];
  const relative='tiktok/alice/live/test.mp4';
  fs.mkdirSync(path.dirname(path.join(f.root,relative)),{recursive:true});fs.writeFileSync(path.join(f.root,relative),Buffer.alloc(4096));
  atomic(path.join(f.stateDir,'tiktok/events','c'.repeat(64)+'.json'),{username:'alice',kind:'video',at:2000,text:'video ready',files:[relative],recipients});
  atomic(path.join(f.stateDir,'tiktok/events','d'.repeat(64)+'.json'),{username:'alice',kind:'start',at:3000,text:'new LIVE',files:[],recipients});
  let release,entered;const waiting=new Promise(r=>{entered=r;}), upload=new Promise(r=>{release=r;});const seen=[];
  const client={call:async(method,body,opts)=>{opts.beforeRequest?.();seen.push(body.text||method);if(method==='sendVideo'){entered();await upload;}return{message_id:1};}};
  const delivery=new TikTokDelivery({...f,settings:()=>s});
  const video=delivery.drain(client,{lane:'video'});await waiting;
  await delivery.drain(client,{lane:'notice'});
  assert.ok(seen.includes('new LIVE'));release();await video;
});
test('legacy LIVE preferences migrate without resetting generation or prior choices', t => {
  const f=fixture(t),s=f.settings;
  applyUpdate(s,msg(1,100,'/ttadd alice'),1000);
  const sub=s.users['100'].tiktokTargets.alice;
  sub.notifications.video.enabled=false;
  const generation=sub.generation;
  for(const kind of ['post','repost','story','profile','like']) delete sub.notifications[kind];
  atomic(path.join(f.dir,'settings.json'),s);
  const migrated=initializeSettings(f.env,5000).users['100'].tiktokTargets.alice;
  assert.equal(migrated.generation,generation);assert.equal(migrated.notifications.video.enabled,false);
  assert.deepEqual(migrated.notifications.story,{enabled:true,since:5000});
  assert.equal(migrated.notifications.like.enabled,false);
});
test('content lane sends ordered photo albums and complete text, with durable acknowledgements', async t => {
  const f=fixture(t),s=f.settings;
  applyUpdate(s,msg(1,100,'/ttadd alice'),1000);
  const files=Array.from({length:12},(_,i)=>`tiktok/alice/posts/123/${i+1}.jpg`);
  for(const file of files){fs.mkdirSync(path.dirname(path.join(f.root,file)),{recursive:true});fs.writeFileSync(path.join(f.root,file),Buffer.alloc(40));}
  const event={username:'alice',kind:'post',at:2000,text:'x'.repeat(5000),files,recipients:[{userId:'100',generation:s.users['100'].tiktokTargets.alice.generation}]};
  atomic(path.join(f.stateDir,'tiktok/events','e'.repeat(64)+'.json'),event);
  const calls=[];const client={call:async(method,body,opts)=>{opts.beforeRequest?.();calls.push([method,body]);return method==='sendMediaGroup'?body.media.map((_,i)=>({message_id:i+1})):{message_id:1};}};
  const delivery=new TikTokDelivery({...f,settings:()=>s});
  assert.equal(await delivery.drain(client,{lane:'content'}),true);
  assert.deepEqual(calls.map(c=>c[0]),['sendMessage','sendMessage','sendMediaGroup','sendMediaGroup']);
  assert.equal(calls[2][1].media.length,10);assert.equal(calls[3][1].media.length,2);
  assert.ok(calls[2][1].media[0].media.endsWith('/1.jpg'));
  const restarted=new TikTokDelivery({...f,settings:()=>s});
  assert.equal(await restarted.drain(client,{lane:'content'}),true);assert.equal(calls.length,4);
});
test('content notification toggle and traversal protection isolate from LIVE delivery', async t => {
  const f=fixture(t),s=f.settings;applyUpdate(s,msg(1,100,'/ttadd alice'),1000);
  const sub=s.users['100'].tiktokTargets.alice,gen=sub.generation.slice(0,8);
  applyUpdate(s,cb(2,100,`tt:set:alice:story:0:${gen}`),2000);
  assert.equal(sub.notifications.story.enabled,false);assert.equal(sub.notifications.video.enabled,true);
  const event={username:'alice',kind:'post',at:3000,text:'test',files:['tiktok/alice/posts/../secret.jpg'],recipients:[{userId:'100',generation:sub.generation}]};
  atomic(path.join(f.stateDir,'tiktok/events','f'.repeat(64)+'.json'),event);
  const client={call:async(_m,_b,opts)=>{opts.beforeRequest?.();return{message_id:1};}};
  assert.equal(await new TikTokDelivery({...f,settings:()=>s}).drain(client,{lane:'content'}),false);
});
test('notice lane is not starved behind more than 100 queued videos', async t => {
  const f=fixture(t),s=f.settings;applyUpdate(s,msg(1,100,'/ttadd alice'),1000);
  const recipients=[{userId:'100',generation:s.users['100'].tiktokTargets.alice.generation}];
  for(let i=0;i<101;i++)atomic(path.join(f.stateDir,'tiktok/events',i.toString(16).padStart(64,'0')+'.json'),{username:'alice',kind:'video',at:2000,text:'video',files:[],recipients});
  atomic(path.join(f.stateDir,'tiktok/events','f'.repeat(64)+'.json'),{username:'alice',kind:'start',at:2000,text:'LIVE',files:[],recipients});
  const calls=[];await new TikTokDelivery({...f,settings:()=>s}).drain({call:async(_m,b,o)=>{o.beforeRequest();calls.push(b.text);return{message_id:1};}},{lane:'notice'});
  assert.deepEqual(calls,['LIVE']);
});
test('oversized or extreme-dimension photos use documents; ordinary PNG uses photo', async t => {
  const {tikTokContentPlan}=await import('../src/tiktok-content-files.mjs');
  const f=fixture(t),files=['tiktok/alice/posts/123/1.png','tiktok/alice/posts/123/2.png','tiktok/alice/posts/123/3.png'];
  for(const [i,file] of files.entries()){
    const p=path.join(f.root,file);fs.mkdirSync(path.dirname(p),{recursive:true});const buf=Buffer.alloc(32);Buffer.from([137,80,78,71,13,10,26,10]).copy(buf);buf.writeUInt32BE(i===1?20000:100,16);buf.writeUInt32BE(100,20);fs.writeFileSync(p,buf);if(i===2)fs.truncateSync(p,10_000_001);
  }
  const actions=tikTokContentPlan({username:'alice',kind:'post',text:'test',files},f.root);
  assert.equal(actions[1].method,'sendPhoto');assert.equal(actions[2].method,'sendMediaGroup');
  assert.ok(actions[2].body.media.every(m=>m.type==='document'));
});
test('Story lane sends while a post video upload is still pending', async t => {
  const f=fixture(t),s=f.settings;applyUpdate(s,msg(1,100,'/ttadd alice'),1000);
  const recipients=[{userId:'100',generation:s.users['100'].tiktokTargets.alice.generation}],file='tiktok/alice/posts/123/01.mp4';
  fs.mkdirSync(path.dirname(path.join(f.root,file)),{recursive:true});fs.writeFileSync(path.join(f.root,file),Buffer.alloc(4096));
  atomic(path.join(f.stateDir,'tiktok/events','a'.repeat(64)+'.json'),{username:'alice',kind:'post',at:2000,text:'post ready',files:[file],recipients});
  atomic(path.join(f.stateDir,'tiktok/events','b'.repeat(64)+'.json'),{username:'alice',kind:'story',at:3000,text:'new Story',files:[],recipients});
  let entered,release;const wait=new Promise(r=>{entered=r;}),hold=new Promise(r=>{release=r;}),seen=[];
  const client={call:async(method,body,opts)=>{opts.beforeRequest();seen.push(body.text||method);if(method==='sendVideo'){entered();await hold;}return{message_id:1};}};
  const delivery=new TikTokDelivery({...f,settings:()=>s}),post=delivery.drain(client,{lane:'content'});
  await wait;await delivery.drain(client,{lane:'story'});assert.ok(seen.includes('new Story'));release();await post;
});
test('manual TikTok downloads enqueue without subscriptions and enforce ten links', t => {
  const { settings: s, ...f } = fixture(t);
  applyUpdate(s, msg(1, 100, 'https://www.tiktok.com/@alice/video/123'));
  assert.equal(s.tiktokRequests['100-1-0'].url, 'https://www.tiktok.com/@alice/video/123');
  const delivery = new TikTokDelivery({ ...f, settings: () => s });
  const event = { requestId: '100-1-0', requestUrl: s.tiktokRequests['100-1-0'].url };
  assert.equal(delivery.eligible(event, { userId: '100' }), true);
  assert.equal(delivery.eligible(event, { userId: '200' }), false);
  applyUpdate(s, msg(2, 100, Array(11).fill('vt.tiktok.com/ABC/').join(' ')));
  assert.equal(Object.keys(s.tiktokRequests).length, 1);
});
