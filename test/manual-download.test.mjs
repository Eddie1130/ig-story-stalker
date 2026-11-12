import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseInstagramLink, instagramLinks, shortcodeId } from '../src/instagram-links.mjs';
import { normalizeManual, bestMedia } from '../src/manual-media.mjs';
import { manualSpec, resolveShare } from '../src/fetch-manual.mjs';
import { ManualJobs, jobFile } from '../src/manual-jobs.mjs';
import { ManualDelivery, albumPlan } from '../src/manual-delivery.mjs';
import { manualPath } from '../src/manual-files.mjs';
import { initializeSettings, settingsFile } from '../src/telegram-settings.mjs';
import { applyUpdate } from '../src/telegram-menu.mjs';
import { TelegramClient } from '../src/telegram-client.mjs';
import { atomic } from '../src/error-monitor.mjs';
import { installCatalogGuard } from '../src/catalog-api.mjs';

const mediaUrl = 'https://s.cdninstagram.com/original.jpg';
const img = (id = '7') => ({ pk: id, media_type: 1, taken_at: 1700000000, image_versions2: { candidates: [{ url: mediaUrl, width: 1920, height: 1080 }] } });
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ig-manual-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const stateDir = path.join(dir, 'state'), root = path.join(dir, 'downloads'), controlDir = path.join(dir, 'control');
  fs.mkdirSync(stateDir); fs.mkdirSync(root);
  const settings = initializeSettings({ IG_CONTROL_DIR: controlDir, TELEGRAM_CHAT_ID: '100', TELEGRAM_ALLOWED_USER_IDS: '200' }, 1000);
  const control = { stopping: false, signal: new AbortController().signal, onChild: () => {} };
  const request = { id: '100-1-0', userId: '100', url: 'https://www.instagram.com/p/ABC/', at: 1000 };
  settings.manualRequests = { [request.id]: request };
  const jpeg = Buffer.alloc(32); jpeg[0] = 255; jpeg[1] = 216; jpeg[2] = 255;
  const downloader = async (root, base) => { fs.mkdirSync(path.dirname(path.join(root, base)), { recursive: true }); fs.writeFileSync(path.join(root, base + '.jpg'), jpeg); return { relativePath: base + '.jpg', bytes: jpeg.length }; };
  const result = { version: 1, requestedUrl: request.url, url: request.url, identity: 'post:ABC', kind: 'post', contentId: shortcodeId('ABC'), username: 'alice', ownerId: '101', caption: 'caption', guard: { allowedRead: 1, blockedReadReceipt: 0 }, media: [bestMedia(img())] };
  return { dir, stateDir, root, controlDir, settings, control, request, jpeg, downloader, result };
}
function ready(f, files) {
  atomic(jobFile(f.stateDir, f.request.id), { version: 1, id: f.request.id, userId: f.request.userId, url: f.request.url, status: 'ready', result: { ...f.result, files, errors: [], total: files.length } });
}
function fileRecord(f, id = '7', bytes) {
  const relativePath = `manual/alice/post/66/${id}.jpg`;
  manualPath(f.root, path.dirname(relativePath), { mkdir: true, directory: true });
  fs.writeFileSync(path.join(f.root, relativePath), f.jpeg);
  if (bytes) fs.truncateSync(path.join(f.root, relativePath), bytes);
  return { id, relativePath, bytes: bytes || f.jpeg.length, mediaType: 1, width: 1920, height: 1080 };
}
const userMessage = (id, text) => ({ update_id: id, message: { from: { id: 100 }, chat: { type: 'private', id: 100 }, text } });

test('content parser canonicalizes tracking/index parameters, all supported formats and exact identities', () => {
  assert.equal(parseInstagramLink('https://instagram.com/p/ABC/?img_index=3&igsh=secret').url, 'https://www.instagram.com/p/ABC/');
  assert.equal(parseInstagramLink('https://www.instagram.com/reel/ABC/').identity, 'post:ABC');
  assert.equal(parseInstagramLink('instagram.com/stories/Alice/123/').identity, 'story:123');
  assert.equal(parseInstagramLink('https://www.instagram.com/stories/highlights/456/').kind, 'highlight');
  assert.equal(parseInstagramLink('https://www.instagram.com/share/reel/token/').kind, 'share');
  assert.equal(parseInstagramLink('https://instagram.com/ALICE/?igsh=secret').username, 'alice');
  assert.equal(shortcodeId('ABC'), '66');
});

test('link parser rejects credentials, ports, local/other hosts and mutation paths', () => {
  for (const link of ['https://instagram.com.evil/p/ABC/', 'https://instagram.com@evil/p/ABC/', 'https://user:secret@instagram.com/p/ABC/',
    'http://127.0.0.1/p/ABC/', 'https://instagram.com:8080/p/ABC/', 'https://instagram.com/api/v1/media/seen/', 'https://instagram.com/stories/../accounts/', 'https://instagram.com/%61lice/']) {
    assert.throws(() => parseInstagramLink(link), /MANUAL_/);
  }
  assert.throws(() => instagramLinks(Array(11).fill('https://instagram.com/p/ABC/').join(' ')), /TOO_MANY/);
  const mixed = instagramLinks('https://instagram.com/p/ABC/ https://example.com/bad');
  assert.deepEqual(mixed.map(x => x.kind), ['post', 'invalid']);
});

test('private batch submission persists distinct repeated jobs, ignores notification toggles and confirms profile follows', t => {
  const f = fixture(t); f.settings.manualRequests = {};
  applyUpdate(f.settings, userMessage(5, 'https://instagram.com/p/ABC/?img_index=3 https://instagram.com/reel/XYZ/ https://instagram.com/alice/'), 2000);
  assert.equal(Object.keys(f.settings.manualRequests).length, 2);
  assert.equal(Object.keys(f.settings.users['100'].targets).length, 0);
  const reply = f.settings.replies['reply:5'];
  assert.ok(reply.body.reply_markup.inline_keyboard.flat().some(b => b.callback_data === 'follow:alice'));
  applyUpdate(f.settings, { update_id: 6, callback_query: { id: '6', from: { id: 100 }, message: { chat: { id: 100, type: 'private' } }, data: 'follow:alice' } }, 2100);
  assert.ok(f.settings.users['100'].targets.alice);
  applyUpdate(f.settings, userMessage(7, 'https://instagram.com/p/ABC/'), 2200);
  assert.equal(Object.keys(f.settings.manualRequests).length, 3);
  const before = Object.keys(f.settings.manualRequests).length;
  const unauthorized = userMessage(8, 'https://instagram.com/p/ABC/'); unauthorized.message.from.id = unauthorized.message.chat.id = 999;
  applyUpdate(f.settings, unauthorized, 2300);
  assert.equal(Object.keys(f.settings.manualRequests).length, before);
});

test('a bad URL in a batch does not discard valid jobs; hidden text links also work', t => {
  const f = fixture(t); f.settings.manualRequests = {};
  applyUpdate(f.settings, userMessage(2, 'https://instagram.com/p/ABC/ https://example.com/bad'), 2000);
  assert.equal(Object.keys(f.settings.manualRequests).length, 1);
  const msg = userMessage(3, 'download this'); msg.message.entities = [{ type: 'text_link', url: 'https://instagram.com/p/XYZ/' }];
  applyUpdate(f.settings, msg, 2000); assert.equal(Object.keys(f.settings.manualRequests).length, 2);
});

test('normalization requires requested post ID, complete carousel and picks highest image/video including DASH', () => {
  const p = { ...img('66'), user: { pk: '101', username: 'Alice' }, media_type: 8, carousel_media_count: 2,
    carousel_media: [img('7'), { pk: '8', media_type: 2, taken_at: 1700000000, video_versions: [{ url: 'https://s.cdninstagram.com/v.mp4', width: 640, height: 360, bitrate: 100 }],
      manualDash: { video: { url: 'https://s.cdninstagram.com/hd.mp4', width: 1920, height: 1080, bitrate: 300 }, audio: { url: 'https://s.cdninstagram.com/audio.mp4' } } }] };
  const r = normalizeManual({ items: [p] }, parseInstagramLink('https://instagram.com/reel/ABC/'));
  assert.deepEqual(r.media.map(x => x.id), ['7', '8']); assert.ok(r.media[1].dash);
  assert.throws(() => normalizeManual({ items: [{ ...p, pk: '67' }] }, parseInstagramLink('https://instagram.com/p/ABC/')), /MISMATCH/);
  assert.throws(() => normalizeManual({ items: [{ ...p, carousel_media_count: 3 }] }, parseInstagramLink('https://instagram.com/p/ABC/')), /INCOMPLETE/);
});

test('Story lookup returns only requested item and Highlights require complete matching collection', () => {
  const spec = parseInstagramLink('https://instagram.com/stories/alice/7/');
  const body = { data: { xdt_api__v1__feed__reels_media: { reels_media: [{ id: '101', user: { pk: '101', username: 'alice' }, items: [img('7'), img('8')] }] } } };
  assert.deepEqual(normalizeManual(body, spec, '101').media.map(x => x.id), ['7']);
  assert.throws(() => normalizeManual(body, { ...spec, contentId: '9' }, '101'), /UNAVAILABLE/);
  const h = { data: { xdt_api__v1__feed__reels_media__connection: { edges: [{ node: { id: 'highlight:456', user: { pk: '101', username: 'alice' }, items: [img()] } }], page_info: { has_next_page: false, has_previous_page: false } } } };
  assert.equal(normalizeManual(h, parseInstagramLink('https://instagram.com/stories/highlights/456/')).media.length, 1);
  h.data.xdt_api__v1__feed__reels_media__connection.page_info.has_next_page = true;
  assert.throws(() => normalizeManual(h, parseInstagramLink('https://instagram.com/stories/highlights/456/')), /INCOMPLETE/);
});

test('manual guard permits only pinned content read and rejects seen, writes and different IDs', async () => {
  let handler;
  const spec = manualSpec(parseInstagramLink('https://instagram.com/p/ABC/'));
  const guard = await installCatalogGuard({ route: async (_, h) => { handler = h; } }, spec);
  const run = async (url, method = 'GET') => {
    let result;
    await handler({ request: () => ({ url: () => url, method: () => method, postData: () => '', resourceType: () => 'fetch', isNavigationRequest: () => false }), continue: async () => { result = 'allowed'; }, abort: async () => { result = 'blocked'; } });
    return result;
  };
  assert.equal(await run('https://www.instagram.com/api/v1/media/67/info/'), 'blocked');
  assert.equal(await run('https://www.instagram.com/api/v1/media/66/info/'), 'allowed');
  assert.equal(await run('https://www.instagram.com/api/v1/media/66/info/'), 'blocked');
  assert.equal(await run('https://www.instagram.com/api/v1/media/seen/', 'POST'), 'blocked');
  assert.equal(guard.blockedReadReceipt, 1);
});

test('share resolution validates every redirect and never follows a foreign URL', async () => {
  let reads = 0;
  const context = { request: { get: async url => { reads++; assert.ok(url.startsWith('https://www.instagram.com/')); return { status: () => 302, headers: () => ({ location: 'https://example.com/p/ABC/' }), dispose: async () => {} }; } } };
  await assert.rejects(resolveShare(context, parseInstagramLink('https://instagram.com/share/token/')), /INVALID_LINK/);
  assert.equal(reads, 1);
});

test('manual jobs archive files and reuse validated complete cache across repeated requests and restart', async t => {
  const f = fixture(t); let fetches = 0;
  const jobs = new ManualJobs({ ...f, settings: () => f.settings, fetcher: async () => { fetches++; return f.result; } });
  assert.equal(await jobs.runOne(), true);
  const saved = JSON.parse(fs.readFileSync(jobFile(f.stateDir, f.request.id), 'utf8'));
  assert.equal(saved.status, 'ready'); assert.ok(fs.existsSync(path.join(f.root, saved.result.files[0].relativePath)));
  const second = { ...f.request, id: '100-2-0', at: 2000 }; f.settings.manualRequests[second.id] = second;
  const restarted = new ManualJobs({ ...f, settings: () => f.settings, fetcher: () => assert.fail('cache must avoid another IG request') });
  await restarted.runOne(); assert.equal(fetches, 1);
  assert.equal(JSON.parse(fs.readFileSync(jobFile(f.stateDir, second.id), 'utf8')).reused, true);
});

test('manual job download failures remain retryable and a later request can still complete', async t => {
  const f = fixture(t); f.settings.manualRequests['100-2-0'] = { ...f.request, id: '100-2-0', url: 'https://www.instagram.com/p/XYZ/', at: 2000 };
  const jobs = new ManualJobs({ ...f, settings: () => f.settings, fetcher: async plan => {
    if (plan.shortcode === 'ABC') throw Error('MANUAL_BROWSER_OR_NETWORK_ERROR');
    return { ...f.result, requestedUrl: plan.url, url: plan.url, identity: plan.identity, contentId: shortcodeId(plan.shortcode) };
  } });
  await jobs.runOne(); assert.equal(JSON.parse(fs.readFileSync(jobFile(f.stateDir, f.request.id))).status, 'retry');
  await jobs.runOne(); assert.equal(JSON.parse(fs.readFileSync(jobFile(f.stateDir, '100-2-0'))).status, 'ready');
});

test('manual storage refuses symlink escapes and removed users never trigger a fetch', async t => {
  const f = fixture(t); fs.mkdirSync(path.join(f.root, 'manual')); fs.symlinkSync(f.dir, path.join(f.root, 'manual/alice'));
  assert.throws(() => manualPath(f.root, 'manual/alice/post/66/1.jpg'), /UNSAFE/);
  f.settings.allowedIds = ['200'];
  const jobs = new ManualJobs({ ...f, settings: () => f.settings, fetcher: () => assert.fail('revoked user') });
  assert.equal(await jobs.runOne(), false);
});

test('albums preserve original order, split at ten, isolate documents and retain oversized files', () => {
  const files = Array.from({ length: 21 }, (_, i) => ({ id: String(i), bytes: 100, mediaType: i%2 ? 2 : 1 }));
  assert.deepEqual(albumPlan(files).groups.map(g => g.length), [10,10,1]);
  const plan = albumPlan([{ id: 'a', bytes: 100, mediaType: 1 }, { id: 'b', bytes: 12_000_000, mediaType: 1 }, { id: 'c', bytes: 51_000_000, mediaType: 2 }]);
  assert.deepEqual(plan.groups.map(g => g[0].type), ['photo','document']); assert.equal(plan.oversized[0].id, 'c');
});

test('manual upload uses local multipart albums and per-group durable receipts prevent replay', async t => {
  const f = fixture(t), records = Array.from({ length: 11 }, (_, i) => fileRecord(f, String(i+1)));
  ready(f, records); const calls = [];
  const delivery = new ManualDelivery({ root: f.root, dir: f.controlDir, stateDir: f.stateDir, settings: () => f.settings });
  const client = { call: async (method, body, options) => {
    options?.beforeRequest?.(); calls.push({ method, body, files: options?.files });
    return method === 'sendMediaGroup' ? body.media.map((_,i) => ({ message_id: i+1 })) : { message_id: 50 };
  } };
  await delivery.drain(client);
  assert.deepEqual(calls.map(c => c.method), ['sendMediaGroup', 'sendPhoto']);
  assert.equal(calls[0].files.length, 10); assert.equal(calls[0].files[0].blob.size, 32);
  const restarted = new ManualDelivery({ root: f.root, dir: f.controlDir, stateDir: f.stateDir, settings: () => f.settings });
  await restarted.drain({ call: () => assert.fail('acknowledged groups must not resend') });
});

test('unknown upload outcomes and in-flight restart keep files and do not blindly resend', async t => {
  const f = fixture(t); ready(f, [fileRecord(f)]);
  let uploads = 0, warnings = 0;
  const options = { root: f.root, dir: f.controlDir, stateDir: f.stateDir, settings: () => f.settings };
  const delivery = new ManualDelivery(options);
  await delivery.drain({ call: async (method, _body, opts) => {
    if (method === 'sendPhoto') { uploads++; opts.beforeRequest(); throw Error('TELEGRAM_NETWORK_OR_RESPONSE_ERROR'); }
    warnings++; return { message_id: 5 };
  } });
  assert.equal(uploads, 1); assert.equal(warnings, 1);
  const restarted = new ManualDelivery(options);
  await restarted.drain({ call: () => assert.fail('uncertain item must not reupload') });
  assert.ok(fs.existsSync(path.join(f.root, 'manual/alice/post/66/7.jpg')));
});

test('cloud oversize is preserved locally and reported while other media is sent', async t => {
  const f = fixture(t), files = [fileRecord(f, '1'), fileRecord(f, '2', 51_000_001)]; ready(f, files);
  const calls = [], d = new ManualDelivery({ root: f.root, dir: f.controlDir, stateDir: f.stateDir, settings: () => f.settings });
  await d.drain({ call: async (method, body, options) => { options?.beforeRequest?.(); calls.push({ method, body }); return { message_id: 1 }; } });
  assert.deepEqual(calls.map(c => c.method), ['sendPhoto', 'sendMessage']); assert.match(calls[1].body.text, /檔案過大/);
  assert.equal(fs.statSync(path.join(f.root, files[1].relativePath)).size, 51_000_001);
});

test('Telegram client serializes multipart without JSON or loading local files into memory', async t => {
  const f = fixture(t); let received;
  const client = new TelegramClient({ token: '123:abc', dir: f.controlDir, sleep: async () => {}, fetchImpl: async (_url, options) => {
    received = options;
    return { ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) };
  } });
  await client.call('sendPhoto', { chat_id: '100', photo: 'attach://file' }, { files: [{ name: 'file', filename: 'x.jpg', blob: new Blob([f.jpeg]) }] });
  assert.ok(received.body instanceof FormData); assert.equal(received.headers['content-type'], undefined); assert.equal(received.body.get('file').size, 32);
});

test('successful carousel files are returned even if subsequent metadata retries all fail', async t => {
  const f = fixture(t), files = [];
  const result = { ...f.result, media: [bestMedia(img('7')), bestMedia(img('8'))] };
  let fetches = 0;
  const options = { ...f, settings: () => f.settings, fetcher: async () => { if (++fetches > 1) throw Error('MANUAL_BROWSER_OR_NETWORK_ERROR'); return result; },
    downloader: async (...args) => { if (args[2].id === '8') throw Error('NAS_HTTP_503'); return f.downloader(...args); } };
  const jobs = new ManualJobs(options);
  for (let i=0;i<3;i++) {
    if(i) { const job=JSON.parse(fs.readFileSync(jobFile(f.stateDir,f.request.id)));job.retryAt=0;atomic(jobFile(f.stateDir,f.request.id),job); }
    await jobs.runOne();
  }
  const job = JSON.parse(fs.readFileSync(jobFile(f.stateDir, f.request.id)));
  assert.equal(job.status, 'ready'); assert.equal(job.result.files.length, 1); assert.equal(job.result.errors.length, 1);
  const d = new ManualDelivery({ root:f.root, dir:f.controlDir, stateDir:f.stateDir, settings:()=>f.settings });
  await d.drain({ call: async (method, body, opts) => { opts?.beforeRequest?.();files.push(method);return {message_id:1}; } });
  assert.deepEqual(files, ['sendPhoto','sendMessage']);
});

test('mid-carousel shutdown preserves a usable partial snapshot for a later unavailable source', async t => {
  const f = fixture(t), result = { ...f.result, media: [bestMedia(img('7')), bestMedia(img('8'))] };
  const first = new ManualJobs({ ...f, settings:()=>f.settings, fetcher:async()=>result,
    downloader:async (...args)=>{const saved=await f.downloader(...args);f.control.stopping=true;return saved;} });
  await first.runOne();
  let job=JSON.parse(fs.readFileSync(jobFile(f.stateDir,f.request.id)));
  assert.equal(job.status,'queued');assert.equal(job.result.files.length,1);assert.equal(job.result.errors.length,1);
  f.control.stopping=false;
  const restarted=new ManualJobs({...f,settings:()=>f.settings,fetcher:async()=>{throw Error('MANUAL_HTTP_404');}});
  await restarted.runOne();job=JSON.parse(fs.readFileSync(jobFile(f.stateDir,f.request.id)));
  assert.equal(job.status,'ready');assert.equal(job.result.files[0].id,'7');
});

test('a queued manual job takes priority immediately after a background Story fetch', async t => {
  const { createTargetWatcher }=await import('../src/watch-media.mjs');
  const f=fixture(t);let pending=false;
  const watcher=createTargetWatcher({target:'101',username:'alice',dir:f.stateDir,root:null,interval:300,control:f.control,env:{IG_CATALOG_ENABLED:'0'},
    telegram:()=>assert.fail('yield before delivery'),yieldToManual:()=>pending,
    fetcher:async(_script,_child,_timeout,env)=>{
      fs.writeFileSync(env.IG_STORY_RESULT_FILE,JSON.stringify({version:1,targetUserId:'101',storyCount:0,stories:[],skippedIds:[]}));
      pending=true;return{targetUserId:'101',storyCount:0,stories:[],guard:{blockedReadReceipt:0}};
    }});
  assert.deepEqual(await watcher.cycle(),{yielded:true});
  pending=false;await watcher.cycle();
});

test('catalog yields between posts and highlight reads without losing scan checkpoints',async t=>{
  const { CatalogWatcher }=await import('../src/catalog-watch.mjs');
  const f=fixture(t),reads=[];let pending=false;
  const catalog=new CatalogWatcher({root:f.root,stateDir:f.stateDir,target:'101',username:'alice',log:()=>{},fetcher:async plan=>{
    reads.push(plan.kind);pending=true;
    return{version:1,target:'101',guard:{allowedQuery:1,blockedReadReceipt:0},kind:'posts',posts:[],hasNext:false,cursor:null};
  }});
  await catalog.check(f.control.signal,()=>{},{shouldYield:()=>pending});
  assert.deepEqual(reads,['posts']);assert.equal(catalog.state.posts.baseline,true);assert.equal(catalog.state.highlights.baseline,false);
});

test('corrupt manual job history is isolated without overwriting files or blocking other requests',async t=>{
  const f=fixture(t);fs.mkdirSync(path.dirname(jobFile(f.stateDir,f.request.id)),{recursive:true});fs.writeFileSync(jobFile(f.stateDir,f.request.id),'{');
  const next={...f.request,id:'100-2-0',at:2000};f.settings.manualRequests[next.id]=next;
  const jobs=new ManualJobs({...f,settings:()=>f.settings,fetcher:async()=>f.result});await jobs.runOne();
  assert.equal(fs.readFileSync(jobFile(f.stateDir,f.request.id),'utf8'),'{');
  assert.equal(JSON.parse(fs.readFileSync(jobFile(f.stateDir,next.id))).status,'ready');
});

test('malformed fields in a parseable manual job are isolated before the worker starts it',async t=>{
  const f=fixture(t);f.settings.manualRequests['100-2-0']={...f.request,id:'100-2-0',at:2000};
  atomic(jobFile(f.stateDir,f.request.id),{version:1,id:f.request.id,userId:f.request.userId,url:f.request.url,status:'queued',attempts:'broken',files:{}});
  const jobs=new ManualJobs({...f,settings:()=>f.settings,fetcher:async()=>f.result});await jobs.runOne();
  assert.equal(JSON.parse(fs.readFileSync(jobFile(f.stateDir,f.request.id))).attempts,'broken');
  assert.equal(JSON.parse(fs.readFileSync(jobFile(f.stateDir,'100-2-0'))).status,'ready');
});

test('a literal null job is reported safely and never poisons background work or other jobs',async t=>{
  const f=fixture(t);atomic(jobFile(f.stateDir,f.request.id),null);
  f.settings.manualRequests['100-2-0']={...f.request,id:'100-2-0',at:2000};
  const jobs=new ManualJobs({...f,settings:()=>f.settings,fetcher:async()=>f.result});await jobs.runOne();
  assert.equal(fs.readFileSync(jobFile(f.stateDir,f.request.id),'utf8'),'null');
  const methods=[],d=new ManualDelivery({root:f.root,dir:f.controlDir,stateDir:f.stateDir,settings:()=>f.settings});
  await d.drain({call:async(method,body,opts)=>{opts?.beforeRequest?.();methods.push(method);return{message_id:1};}});
  assert.deepEqual(methods,['sendMessage','sendPhoto']);
});

test('a crash after request start is uncertain on restart and only sends a notice, never media again',async t=>{
  const f=fixture(t);ready(f,[fileRecord(f)]);
  const options={root:f.root,dir:f.controlDir,stateDir:f.stateDir,settings:()=>f.settings};
  const first=new ManualDelivery(options);
  await assert.rejects(first.drain({call:async(_m,_b,opts)=>{opts.beforeRequest();throw Object.assign(Error('simulated exit'),{code:'EIO'});}}),/simulated exit/);
  const restarted=new ManualDelivery(options),methods=[];
  await restarted.drain({call:async method=>{methods.push(method);return{message_id:1};}});
  assert.deepEqual(methods,['sendMessage']);assert.equal(restarted.state.jobs[f.request.id].uncertain,true);
});

test('confirmed 400 fallback uploads the same original as a document without recompression',async t=>{
  const f=fixture(t);ready(f,[fileRecord(f)]);const methods=[];
  const d=new ManualDelivery({root:f.root,dir:f.controlDir,stateDir:f.stateDir,settings:()=>f.settings});
  await d.drain({call:async(method,_body,opts)=>{opts?.beforeRequest?.();methods.push(method);if(method==='sendPhoto')throw Error('TELEGRAM_ERROR_400');assert.equal(opts.files[0].blob.size,32);return{message_id:1};}});
  assert.deepEqual(methods,['sendPhoto','sendDocument']);assert.equal(d.state.jobs[f.request.id].done,true);
});

test('confirmed rate-limit rejection retries safely after cooldown rather than marking uncertain',async t=>{
  const f=fixture(t);ready(f,[fileRecord(f)]);const d=new ManualDelivery({root:f.root,dir:f.controlDir,stateDir:f.stateDir,settings:()=>f.settings});
  await d.drain({rate:{retryAt:Date.now()+60000},call:async(_method,_body,opts)=>{opts.beforeRequest();throw Error('TELEGRAM_ERROR_429');}});
  assert.equal(d.state.jobs[f.request.id].uncertain,undefined);d.state.jobs[f.request.id].retryAt=0;
  const methods=[];await d.drain({call:async(method,_body,opts)=>{opts?.beforeRequest?.();methods.push(method);return{message_id:1};}});
  assert.deepEqual(methods,['sendPhoto']);
});

test('malformed ready results fail only that request and never access arbitrary paths',async t=>{
  const f=fixture(t);ready(f,[fileRecord(f)]);const job=JSON.parse(fs.readFileSync(jobFile(f.stateDir,f.request.id)));job.result.files={};atomic(jobFile(f.stateDir,f.request.id),job);
  const d=new ManualDelivery({root:f.root,dir:f.controlDir,stateDir:f.stateDir,settings:()=>f.settings}),methods=[];
  await d.drain({call:async method=>{methods.push(method);return{message_id:1};}});assert.deepEqual(methods,['sendMessage']);
});

test('private URL input flows through real controller, priority worker and local uploader without a subscription',async t=>{
  const {run}=await import('../src/telegram-control.mjs');const{main}=await import('../src/watch-media.mjs');const f=fixture(t);
  f.settings.manualRequests={};atomic(settingsFile({IG_CONTROL_DIR:f.controlDir}),f.settings);
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    const method=String(url).split('/').at(-1);let result=true;
    if(method==='getWebhookInfo')result={url:''};
    if(method==='getUpdates')result=[userMessage(10,f.request.url)];
    return{ok:true,json:async()=>({ok:true,result})};
  });
  const env={IG_TELEGRAM_CONTROL:'1',IG_CONTROL_DIR:f.controlDir,IG_STATE_DIR:f.stateDir,IG_ARCHIVE_DIR:f.root,TELEGRAM_CHAT_ID:'100',TELEGRAM_ALLOWED_USER_IDS:'200',TELEGRAM_BOT_TOKEN:'123:abc',IG_CATALOG_ENABLED:'0'};
  await run({env,args:['--once']});
  await main({env,dir:f.stateDir,args:['--once'],manualFetcher:async()=>f.result,manualDownloader:f.downloader,sleepImpl:async()=>{}});
  const saved=JSON.parse(fs.readFileSync(settingsFile(env)));assert.equal(Object.keys(saved.users['100'].targets).length,0);
  const id='100-10-0';assert.equal(JSON.parse(fs.readFileSync(jobFile(f.stateDir,id))).status,'ready');
  const d=new ManualDelivery({root:f.root,dir:f.controlDir,stateDir:f.stateDir,settings:()=>saved}),methods=[];
  await d.drain({call:async(method,_body,opts)=>{opts?.beforeRequest?.();methods.push(method);return{message_id:1};}});assert.deepEqual(methods,['sendPhoto']);
});
