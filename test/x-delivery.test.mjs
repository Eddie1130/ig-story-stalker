import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { XDelivery, xTextChunks } from '../src/x-delivery.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'x-delivery-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'control'), stateDir = path.join(root, 'state');
  fs.mkdirSync(path.join(stateDir, 'x/events'), { recursive: true });
  const sub = () => ({ generation: 'generation-1', joinedAt: 100, notifications: Object.fromEntries(['post','repost','reply','quote'].map(k => [k, { enabled: true, since: 100 }])) });
  const settings = { allowedIds: ['1','2'], users: { '1': { xTargets: { alice: sub() } }, '2': { xTargets: { alice: sub() } } }, xRequests: {} };
  const event = { version: 1, id: 'alice:post:123', type: 'post', at: 200, username: 'alice', kind: 'post', statusId: '123', recipients: [{ userId: '1', generation: 'generation-1' }, { userId: '2', generation: 'generation-1' }], result: { username: 'alice', kind: 'post', contentId: '123', url: 'https://x.com/alice/status/123', caption: 'hello', files: [], errors: [] } };
  const publish = (value = event) => fs.writeFileSync(path.join(stateDir, 'x/events', createHash('sha256').update(value.id).digest('hex') + '.json'), JSON.stringify(value));
  const calls = [];
  const client = { rate: {}, async call(method, body, options = {}) { options.beforeRequest?.(); calls.push({method,body,options}); return method === 'sendMediaGroup' ? body.media.map((_,i) => ({ message_id: i+1 })) : { message_id: calls.length }; } };
  const delivery = () => new XDelivery({ root, dir, stateDir, settings: () => settings });
  return { root, dir, stateDir, settings, event, publish, calls, client, delivery };
}

test('X text-only notifications have independent durable receipts and keep full text', async t => {
  const f = fixture(t); f.event.result.caption = '字'.repeat(9000); f.publish();
  assert.equal(await f.delivery().drain(f.client), true);
  assert.equal(f.calls.length, 6);
  for (const id of ['1','2']) {
    const messages = f.calls.filter(c => c.body.chat_id === id);
    assert.ok(messages.every(c => c.method === 'sendMessage' && c.body.text.length <= 4000));
    assert.equal(messages.map(c => c.body.text).join('').match(/字/g).length, 9000);
  }
  f.calls.length = 0; await f.delivery().drain(f.client);
  assert.equal(f.calls.length, 0);
});

test('X delivery rechecks whitelist, generation, joinedAt, and notification switches', async t => {
  const f = fixture(t); f.publish();
  f.settings.allowedIds = ['1']; f.settings.users['1'].xTargets.alice.notifications.post.enabled = false;
  await f.delivery().drain(f.client); assert.equal(f.calls.length, 0);
  f.settings.users['1'].xTargets.alice.notifications.post.enabled = true;
  f.settings.users['1'].xTargets.alice.generation = 'new-generation';
  await f.delivery().drain(f.client); assert.equal(f.calls.length, 0);
});

test('X notices only reach currently authorized subscribers', async t => {
  const f = fixture(t); f.settings.users['2'].xTargets = {};
  f.publish({ ...f.event, type: 'notice', text: '歷史回補完成' });
  await f.delivery().drain(f.client);
  assert.deepEqual(f.calls.map(c => c.body.chat_id), ['1']);
});

test('X manual downloads bypass preferences but require a matching user request', async t => {
  const f = fixture(t); f.settings.users['1'].xTargets = {}; f.settings.users['2'].xTargets = {};
  f.event.manual = true; f.event.userId = '1'; f.event.requestId = '1-10-0';
  f.settings.xRequests['1-10-0'] = { id: '1-10-0', type: 'manual', userId: '1', username: 'alice', url: f.event.result.url };
  f.publish(); await f.delivery().drain(f.client);
  assert.deepEqual(f.calls.map(c => c.body.chat_id), ['1']);
});
test('manual links keep delivering after an author changes their handle', async t => {
  const f=fixture(t);f.event.manual=true;f.event.userId='1';f.event.requestId='1-10-0';
  f.settings.xRequests['1-10-0']={id:'1-10-0',type:'manual',userId:'1',username:'alice',url:'https://x.com/alice/status/123'};
  f.event.result.url='https://x.com/renamed/status/123';f.publish();
  await f.delivery().drain(f.client);assert.equal(f.calls.length,1);
  assert.ok(f.calls[0].body.text.includes('renamed/status/123'));
});

test('X rate-limit rejection retries confirmed unsent text after cooldown', async t => {
  const f = fixture(t); f.event.recipients = f.event.recipients.slice(0,1); f.publish();
  let attempts = 0;
  f.client.call = async (method, body, options) => { options.beforeRequest?.(); if (++attempts === 1) throw Error('TELEGRAM_ERROR_429'); f.calls.push({method,body}); return {message_id:1}; };
  const delivery = f.delivery(); assert.equal(await delivery.drain(f.client), false);
  const receipt = Object.values(delivery.state.receipts)[0]; receipt.retryAt = 0;
  assert.equal(await delivery.drain(f.client), true); assert.equal(f.calls.length, 1);
});

test('X unknown send response becomes uncertain and never blindly resends original content', async t => {
  const f = fixture(t); f.event.recipients = f.event.recipients.slice(0,1); f.publish();
  let attempts = 0;
  f.client.call = async (method, body, options) => { options.beforeRequest?.(); f.calls.push({method,body}); if (++attempts === 1) throw Error('TELEGRAM_NETWORK_OR_RESPONSE_ERROR'); return {message_id:2}; };
  await f.delivery().drain(f.client); await f.delivery().drain(f.client);
  assert.equal(f.calls.filter(c => c.body.text.includes('hello')).length, 1);
  assert.ok(f.calls.some(c => c.body.text.includes('結果不明')));
});

test('X upload groups use shared uploader and preserve group acknowledgements', async t => {
  const f = fixture(t); f.event.recipients = f.event.recipients.slice(0,1);
  f.event.result.files = Array.from({length:11}, (_,i) => ({relativePath:`x/alice/media/${i}.jpg`,bytes:16,mediaType:1}));
  f.publish(); const delivery = f.delivery();
  delivery.upload = async (group, _result, userId) => ({method: group.length > 1 ? 'sendMediaGroup' : 'sendPhoto', body: {chat_id:userId,media:group}, files:[]});
  await delivery.drain(f.client);
  assert.deepEqual(f.calls.map(c => c.method), ['sendMediaGroup','sendPhoto']);
  await delivery.drain(f.client); assert.equal(f.calls.length, 2);
});

test('X invalid event or damaged delivery history fails closed', async t => {
  const f = fixture(t); f.publish({...f.event, username:'../escape'});
  await assert.rejects(f.delivery().drain(f.client), /X_EVENT_INVALID/);
  fs.mkdirSync(f.dir,{recursive:true}); fs.writeFileSync(path.join(f.dir,'x-delivery.json'), '{}');
  assert.throws(() => f.delivery(), /X_DELIVERY_HISTORY_INVALID/);
});

test('X restart with inflight receipt marks it uncertain without original replay', async t => {
  const f = fixture(t); f.event.recipients = f.event.recipients.slice(0,1); f.publish();
  const delivery = f.delivery();
  f.client.call = async (_method,_body,options) => { options.beforeRequest?.(); throw Error('TELEGRAM_STOPPING'); };
  await delivery.drain(f.client);
  const receipt = Object.values(delivery.state.receipts)[0]; receipt.inflight = {at: Date.now()}; receipt.retryAt = 0; delivery.persist();
  const restarted = f.delivery();
  f.client.call = async (method,body,options) => {options.beforeRequest?.(); f.calls.push({method,body}); return {message_id:1};};
  await restarted.drain(f.client);
  assert.ok(f.calls.every(c => !c.body.text.includes('hello')));
});

test('X preference timestamps suppress events older than subscription or re-enable time', async t => {
  const f = fixture(t); f.settings.users['1'].xTargets.alice.joinedAt = 201;
  f.settings.users['2'].xTargets.alice.notifications.post.since = 201;
  f.publish(); await f.delivery().drain(f.client); assert.equal(f.calls.length, 0);
});

test('X manual request cannot leak into another user chat or proceed after removal', async t => {
  const f = fixture(t); f.event.manual = true; f.event.userId = '1'; f.event.requestId = '1-10-0';
  f.settings.xRequests['1-10-0'] = { id:'1-10-0',type:'manual',userId:'2',username:'alice',url:f.event.result.url };
  f.publish(); await f.delivery().drain(f.client); assert.equal(f.calls.length, 0);
});

test('X delivery reports oversized and unavailable media without upload', async t => {
  const f = fixture(t); f.event.recipients = f.event.recipients.slice(0,1);
  f.event.result.files = [{relativePath:'x/alice/media/123.jpg',bytes:50_000_001,mediaType:1}];
  f.event.result.errors = [{reason:'X_MEDIA_UNAVAILABLE'}];
  f.publish(); await f.delivery().drain(f.client);
  assert.deepEqual(f.calls.map(c => c.method), ['sendMessage','sendMessage']);
  assert.ok(f.calls[1].body.text.includes('檔案過大')); assert.ok(f.calls[1].body.text.includes('未能下載'));
});

test('X media upload local failure reports archive retention', async t => {
  const f = fixture(t); f.event.recipients = f.event.recipients.slice(0,1);
  f.event.result.files = [{relativePath:'x/alice/media/123.jpg',bytes:16,mediaType:1}]; f.publish();
  const delivery = f.delivery(); delivery.upload = async () => {throw Error('X_FILE_INCOMPLETE');};
  await delivery.drain(f.client);
  assert.equal(f.calls.length, 2); assert.ok(f.calls[1].body.text.includes('X_FILE_INCOMPLETE'));
});

test('X rejected photo retries as document without changing receipt boundary', async t => {
  const f = fixture(t); f.event.recipients = f.event.recipients.slice(0,1);
  f.event.result.files = [{relativePath:'x/alice/media/123.jpg',bytes:16,mediaType:1}]; f.publish();
  const delivery = f.delivery(), types=[];
  delivery.upload = async (_group,_result,userId,documents) => {types.push(documents);return {method:documents?'sendDocument':'sendPhoto',body:{chat_id:userId},files:[]};};
  f.client.call = async (method,body,options) => {options.beforeRequest?.();f.calls.push({method,body});if(method==='sendPhoto')throw Error('TELEGRAM_ERROR_400');return {message_id:1};};
  assert.equal(await delivery.drain(f.client), true);
  assert.deepEqual(types,[false,true]); assert.deepEqual(f.calls.map(c=>c.method),['sendPhoto','sendDocument']);
});

test('X actual local JPEG upload uses validated X paths', async t => {
  const f = fixture(t); f.event.recipients = f.event.recipients.slice(0,1);
  const image = Buffer.alloc(16);image[0]=255;image[1]=216;image[2]=255;
  fs.mkdirSync(path.join(f.root,'x/alice/media'),{recursive:true});fs.writeFileSync(path.join(f.root,'x/alice/media/123_01.jpg'),image);
  f.event.result.files = [{relativePath:'x/alice/media/123_01.jpg',bytes:16,mediaType:1}];f.publish();
  await f.delivery().drain(f.client);
  assert.deepEqual(f.calls.map(c=>c.method),['sendPhoto']);
  assert.equal(f.calls[0].options.files[0].blob.size,16);
  assert.match(f.calls[0].body.caption, /hello/);
  await f.delivery().drain(f.client);
  assert.equal(f.calls.length, 1);
});

test('manual X link sends a photo with the post text once in its caption', async t => {
  const f=fixture(t);f.event.manual=true;f.event.userId='1';f.event.requestId='1-10-0';f.event.recipients=f.event.recipients.slice(0,1);
  f.settings.xRequests['1-10-0']={id:'1-10-0',type:'manual',userId:'1',username:'alice',url:f.event.result.url};
  const image=Buffer.alloc(16);image[0]=255;image[1]=216;image[2]=255;
  fs.mkdirSync(path.join(f.root,'x/alice/media'),{recursive:true});fs.writeFileSync(path.join(f.root,'x/alice/media/123_01.jpg'),image);
  f.event.result.files=[{relativePath:'x/alice/media/123_01.jpg',bytes:16,mediaType:1}];f.publish();
  await f.delivery().drain(f.client);
  assert.deepEqual(f.calls.map(c=>c.method),['sendPhoto']);
  assert.match(f.calls[0].body.caption,/hello/);assert.match(f.calls[0].body.caption,/https:\/\/x.com\/alice\/status\/123/);
});

test('manual albums carry one caption and keep long text without duplication', async t => {
  const f=fixture(t);f.event.manual=true;f.event.userId='1';f.event.requestId='1-10-0';f.event.recipients=f.event.recipients.slice(0,1);
  f.settings.xRequests['1-10-0']={id:'1-10-0',type:'manual',userId:'1',username:'alice',url:f.event.result.url};
  f.event.result.caption='字'.repeat(1500)+'😀';
  f.event.result.files=Array.from({length:11},(_,i)=>({relativePath:`x/alice/media/${i}.jpg`,bytes:16,mediaType:1}));f.publish();
  const delivery=f.delivery();delivery.upload=async(group,_result,userId)=>({method:group.length>1?'sendMediaGroup':'sendPhoto',body:group.length>1?{chat_id:userId,media:group.map(()=>({type:'photo',media:'attach://x',caption:'old'}))}:{chat_id:userId,caption:'old'},files:[]});
  await delivery.drain(f.client);
  assert.deepEqual(f.calls.map(c=>c.method),['sendMediaGroup','sendPhoto','sendMessage']);
  const caption=f.calls[0].body.media[0].caption,tail=f.calls[2].body.text;
  assert.ok(caption.length<=1024);assert.equal((caption+tail).match(/字/g).length,1500);assert.ok(tail.endsWith('😀'));
  assert.ok(!f.calls[1].body.caption);assert.ok(!f.calls[0].body.media[1].caption);
  await delivery.drain(f.client);assert.equal(f.calls.length,3);
});

test('manual long caption resumes its remaining text after a confirmed rate limit without resending media', async t => {
  const f=fixture(t);f.event.manual=true;f.event.userId='1';f.event.requestId='1-10-0';f.event.recipients=f.event.recipients.slice(0,1);
  f.settings.xRequests['1-10-0']={id:'1-10-0',type:'manual',userId:'1',username:'alice',url:f.event.result.url};
  f.event.result.caption='字'.repeat(1500);f.event.result.files=[{relativePath:'x/alice/media/123_01.jpg',bytes:16,mediaType:1}];f.publish();
  let rejected=false;const send=async(method,body,options)=>{options.beforeRequest?.();if(method==='sendMessage'&&!rejected){rejected=true;throw Error('TELEGRAM_ERROR_429');}f.calls.push({method,body});return {message_id:f.calls.length};};
  f.client.call=send;const delivery=f.delivery();delivery.upload=async(_group,_result,id)=>({method:'sendPhoto',body:{chat_id:id},files:[]});
  assert.equal(await delivery.drain(f.client),false);
  const entry=Object.values(delivery.state.receipts)[0];assert.equal(entry.nextGroup,1);assert.equal(entry.captionMode,true);entry.retryAt=0;delivery.persist();
  const restarted=f.delivery();restarted.upload=async()=>assert.fail('already acknowledged media must not be resent');
  await restarted.drain(f.client);
  assert.deepEqual(f.calls.map(c=>c.method),['sendPhoto','sendMessage']);
  assert.equal((f.calls[0].body.caption+f.calls[1].body.text).match(/字/g).length,1500);
});

test('an old partially delivered manual job keeps its existing receipt order', async t => {
  const f=fixture(t);f.event.manual=true;f.event.userId='1';f.event.requestId='1-10-0';f.event.recipients=f.event.recipients.slice(0,1);
  f.settings.xRequests['1-10-0']={id:'1-10-0',type:'manual',userId:'1',username:'alice',url:f.event.result.url};
  f.event.result.files=[{relativePath:'x/alice/media/123_01.jpg',bytes:16,mediaType:1}];f.publish();
  const delivery=f.delivery(),key=createHash('sha256').update(`${f.event.id}:1`).digest('hex');
  delivery.state.receipts[key]={nextText:1,nextGroup:0,failures:0};delivery.persist();
  delivery.upload=async(_group,_result,id)=>({method:'sendPhoto',body:{chat_id:id,caption:'previous caption'},files:[]});
  await delivery.drain(f.client);
  assert.deepEqual(f.calls.map(c=>c.method),['sendPhoto']);assert.equal(delivery.state.receipts[key].captionMode,undefined);
});

test('manual link sends the full text when the local media cannot be uploaded', async t => {
  const f=fixture(t);f.event.manual=true;f.event.userId='1';f.event.requestId='1-10-0';f.event.recipients=f.event.recipients.slice(0,1);
  f.settings.xRequests['1-10-0']={id:'1-10-0',type:'manual',userId:'1',username:'alice',url:f.event.result.url};
  f.event.result.files=[{relativePath:'x/alice/media/123_01.jpg',bytes:16,mediaType:1}];f.publish();
  const delivery=f.delivery();delivery.upload=async()=>{throw Error('X_FILE_INCOMPLETE');};
  await delivery.drain(f.client);
  assert.deepEqual(f.calls.map(c=>c.method),['sendMessage','sendMessage']);assert.match(f.calls[0].body.text,/hello/);assert.match(f.calls[1].body.text,/X_FILE_INCOMPLETE/);
});

test('X delivery refuses missing required receipt history and symlink events', async t => {
  const f = fixture(t);f.delivery();fs.unlinkSync(path.join(f.dir,'x-delivery.json'));
  assert.throws(()=>f.delivery(),/X_DELIVERY_HISTORY_MISSING/);
  fs.rmSync(path.join(f.dir,'x-delivery.json.required'));
  f.publish();const eventFile=path.join(f.stateDir,'x/events',fs.readdirSync(path.join(f.stateDir,'x/events'))[0]);
  const outside=path.join(f.root,'outside.json');fs.renameSync(eventFile,outside);fs.symlinkSync(outside,eventFile);
  await assert.rejects(f.delivery().drain(f.client),/X_EVENT_INVALID/);
});

test('X text chunks preserve emoji surrogate pairs',()=>{
  const text='a'.repeat(3999)+'😀'+'b'.repeat(10);const chunks=xTextChunks(text);
  assert.equal(chunks.join(''),text);assert.ok(chunks.every(c=>c.length<=4000));assert.equal(chunks[1].startsWith('😀'),true);
});

test('X authorization is rechecked after Telegram rate waiting before the actual request',async t=>{
  const f=fixture(t);f.event.recipients=f.event.recipients.slice(0,1);f.publish();
  f.client.call=async(method,body,options)=>{f.settings.allowedIds=[];options.beforeRequest?.();f.calls.push({method,body});return{message_id:1};};
  await f.delivery().drain(f.client);assert.equal(f.calls.length,0);
});

test('manual X events upload from the new manual directory with existing receipts intact', async t => {
  const f=fixture(t);f.event.manual=true;f.event.userId='1';f.event.requestId='1-10-0';f.event.recipients=f.event.recipients.slice(0,1);
  f.settings.xRequests['1-10-0']={id:'1-10-0',type:'manual',userId:'1',username:'alice',url:f.event.result.url};
  const image=Buffer.from([255,216,255,...Array(13).fill(0)]);
  fs.mkdirSync(path.join(f.root,'x/manual/alice/media'),{recursive:true});fs.writeFileSync(path.join(f.root,'x/manual/alice/media/123_01.jpg'),image);
  f.event.result.files=[{relativePath:'x/manual/alice/media/123_01.jpg',bytes:16,mediaType:1}];f.publish();
  await f.delivery().drain(f.client);await f.delivery().drain(f.client);
  assert.deepEqual(f.calls.map(c=>c.method),['sendPhoto']);assert.match(f.calls[0].body.caption,/hello/);
});

test('automatic X events cannot read a manual directory or another account directory', async t => {
  for (const relativePath of ['x/manual/alice/media/123_01.jpg','x/manual/bob/media/123_01.jpg','x/bob/media/123_01.jpg']) {
    const f=fixture(t);f.event.result.files=[{relativePath,bytes:16,mediaType:1}];f.publish();
    await assert.rejects(f.delivery().drain(f.client),/X_EVENT_INVALID/);
  }
});

test('oversized manual results report the manual archive location', async t => {
  const f=fixture(t);f.event.manual=true;f.event.userId='1';f.event.requestId='1-10-0';f.event.recipients=f.event.recipients.slice(0,1);
  f.settings.xRequests['1-10-0']={id:'1-10-0',type:'manual',userId:'1',username:'alice',url:f.event.result.url};
  f.event.result.files=[{relativePath:'x/manual/alice/media/123_01.jpg',bytes:50_000_001,mediaType:1}];f.publish();
  await f.delivery().drain(f.client);assert.ok(f.calls.some(c=>c.body.text?.includes('downloads/x/manual/alice/')));
});

test('monitored X albums include the post text only in the first media caption', async t => {
  const f=fixture(t);f.event.recipients=f.event.recipients.slice(0,1);
  f.event.result.files=Array.from({length:2},(_,i)=>({relativePath:`x/alice/media/${i}.jpg`,bytes:16,mediaType:1}));f.publish();
  const delivery=f.delivery();
  delivery.upload=async(group,_result,id)=>({method:'sendMediaGroup',body:{chat_id:id,media:group.map(()=>({type:'photo',media:'attach://x',caption:'old'}))},files:[]});
  await delivery.drain(f.client);
  assert.deepEqual(f.calls.map(c=>c.method),['sendMediaGroup']);
  assert.match(f.calls[0].body.media[0].caption,/hello/);
  assert.equal(f.calls[0].body.media[1].caption,undefined);
  await delivery.drain(f.client);assert.equal(f.calls.length,1);
});
