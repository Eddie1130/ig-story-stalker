import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { makeRequest, normalizeResponse, installCatalogGuard, decodeResponse } from '../src/catalog-api.mjs';
import { CatalogWatcher, dateJST, safeTitle } from '../src/catalog-watch.mjs';
import { eventIssue, Issues } from '../src/error-monitor.mjs';
const config={target:'99',username:'test'};
const img=(id='11')=>({pk:id,media_type:1,taken_at:1792080000,image_versions2:{candidates:[{url:'https://s.cdninstagram.com/a.jpg',width:100,height:100}]}});
const video=(id='12')=>({pk:id,media_type:2,taken_at:1792080000,video_versions:[{url:'https://s.cdninstagram.com/a.mp4',width:100,height:100}]});
const post=(id='1')=>({pk:id,media_type:8,taken_at:1792080000,user:{pk:'99'},caption:{text:'caption 日本語'},carousel_media:[img(id+'1'),video(id+'2')],carousel_media_count:2,code:'ABC'});
const body=(posts=[post()],more=false,cursor=null)=>({data:{xdt_api__v1__feed__user_timeline_graphql_connection:{edges:posts.map(node=>({node})),page_info:{has_next_page:more,end_cursor:cursor}}}});
const wrap=r=>({version:1,target:'99',guard:{allowedQuery:1,blockedReadReceipt:0},...r});
function fixture(t,options={}){const root=fs.mkdtempSync(path.join(os.tmpdir(),'ig-catalog-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const media=path.join(root,'media');fs.mkdirSync(media);const log=[];const args={root:media,stateDir:root,target:'99',username:'test',log:(event,data)=>log.push({event,...data}),...options};return {root,media,log,args,watch:new CatalogWatcher(args)};}
test('posts: carousel video preserved, caption and pagination strictness',()=>{
 const r=normalizeResponse(body(),{kind:'posts',cursor:null},'99');assert.deepEqual(r.posts[0].media.map(m=>m.mediaType),[1,2]);assert.equal(r.posts[0].caption,'caption 日本語');
 const bad=post();delete bad.carousel_media[1].video_versions;bad.carousel_media[1].image_versions2=img().image_versions2;
 assert.throws(()=>normalizeResponse(body([bad]),{kind:'posts',cursor:null},'99'),/VIDEO_VARIANT_MISSING/);
 assert.throws(()=>normalizeResponse(body([post()],true,null),{kind:'posts',cursor:null},'99'),/PAGINATION_INVALID/);
 assert.throws(()=>normalizeResponse(body(),{kind:'posts',cursor:null},'100'),/OWNER_MISMATCH/);
 assert.throws(()=>decodeResponse({status:200,text:'<html>error</html>'}),/NON_JSON/);
 assert.equal(decodeResponse({status:200,text:'for (;;);{"status":"ok"}'}).status,'ok');
});
test('highlight normalization requires requested ID and target owner',()=>{
 const plan={kind:'highlight',id:'77'};
 const r=normalizeResponse({data:{xdt_api__v1__feed__reels_media__connection:{edges:[{node:{id:'highlight:77',user:{pk:'99'},items:[img()]}}],page_info:{has_next_page:false,has_previous_page:false}}}},plan,'99');assert.equal(r.media.length,1);
 assert.throws(()=>normalizeResponse({data:{xdt_api__v1__feed__reels_media__connection:{edges:[{node:{id:'highlight:77',user:{pk:'100'},items:[]}}],page_info:{has_next_page:false,has_previous_page:false}}}},plan,'99'),/OWNER/);
 assert.throws(()=>normalizeResponse({reels:{}},plan,'99'),/SCHEMA/);
 assert.equal(dateJST(Date.parse('2026-10-15T16:30:00Z')/1000),'20261016_013000_JST');
 assert.equal(safeTitle('../a/b:*'), '_a_b__');
});
async function guard(spec){let handler;const stats=await installCatalogGuard({route:async(_,h)=>handler=h},spec);return {stats,request:async(url,method,body='',resource='fetch')=>{let action;await handler({request:()=>({url:()=>url,method:()=>method,postData:()=>body,resourceType:()=>resource,isNavigationRequest:()=>resource==='document'}),abort:async()=>action='blocked',continue:async()=>action='allowed'});return action;}};}
test('network guard permits only exact planned reads and blocks seen/write/wrong target/replay',async()=>{
 const spec=makeRequest({kind:'posts',cursor:null},config),g=await guard(spec);
 const form=new URLSearchParams({fb_api_req_friendly_name:spec.friendly,doc_id:spec.doc,variables:JSON.stringify(spec.variables)});
 assert.equal(await g.request('https://www.instagram.com/graphql/query','POST',form.toString()),'allowed');
 assert.equal(await g.request('https://www.instagram.com/graphql/query','POST',form.toString()),'blocked');
 const other=await guard(spec);form.set('variables',JSON.stringify({...spec.variables,username:'someone_else'}));assert.equal(await other.request('https://www.instagram.com/graphql/query','POST',form.toString()),'blocked');
 assert.equal(await other.request('https://www.instagram.com/api/v1/media/seen/','POST',''),'blocked');assert.equal(other.stats.blockedReadReceipt,1);
 assert.equal(await other.request('https://www.instagram.com/api/v1/likes/','POST',''),'blocked');
 const reel=makeRequest({kind:'highlight',id:'77'},config),rg=await guard(reel);
 assert.equal(await rg.request('https://www.instagram.com'+reel.path,'POST',new URLSearchParams({user_ids:'["highlight:78"]'}).toString()),'blocked');
 assert.equal(await rg.request('https://www.instagram.com'+reel.path,'POST',new URLSearchParams({fb_api_req_friendly_name:reel.friendly,doc_id:reel.doc,variables:JSON.stringify(reel.variables)}).toString()),'allowed');
});
test('stable indexing, caption edits, baseline quiet, new media notify, independent retries and restart',async t=>{
 let fail=true,sends=0,downloads=0;
 const f=fixture(t,{downloader:async(root,base,a)=>{downloads++;if(fail)throw Object.assign(Error(),{code:'ENOSPC'});return {relativePath:base+(a.mediaType===2?'.mp4':'.jpg'),bytes:100};}});
 let w=f.watch;const plan={kind:'posts',cursor:null};w.ingest(plan,wrap(normalizeResponse(body(),plan,'99')));w.persist();
 assert.equal(Object.values(w.state.assets).every(a=>a.telegramDone),true);
 assert.match(w.state.posts.records['1'].folder,/^posts\/00001_\d{8}_\d{6}_JST$/);
 await w.deliver(new AbortController().signal,async()=>{sends++;});assert.equal(sends,0);assert.equal(Object.values(w.state.assets).every(a=>!a.archiveDone),true);
 w=new CatalogWatcher(f.args);fail=false;await w.deliver(new AbortController().signal,async()=>{sends++;});assert.equal(Object.values(w.state.assets).every(a=>a.archiveDone),true);
 const oldFolder=w.state.posts.records['1'].folder;const changed=post();changed.caption.text='edited';
 w.ingest(plan,wrap(normalizeResponse(body([post('2'),changed]),plan,'99')));w.persist();assert.equal(w.state.posts.records['1'].folder,oldFolder);
 await w.deliver(new AbortController().signal,async()=>{throw Error('TELEGRAM_ERROR_500');});assert.equal(w.state.assets['post:2:21'].archiveDone,true);assert.equal(w.state.assets['post:2:21'].telegramDone,false);
 const before=downloads;w=new CatalogWatcher(f.args);await w.deliver(new AbortController().signal,async()=>{sends++;});assert.equal(downloads,before);assert.equal(sends,2);
 assert.equal(fs.readFileSync(path.join(f.media,oldFolder,'caption.txt'),'utf8'),'edited');
});
test('highlight stable folder/title and per-highlight failure allows others to progress',async t=>{
 const f=fixture(t,{fetcher:async plan=>{if(plan.id==='77')throw Error('CATALOG_HTTP_403');return wrap({kind:'highlight',id:plan.id,media:[]});}});
 const w=f.watch;w.state.posts.nextAt=Date.now()+1e9;
 w.ingest({kind:'tray'},wrap({kind:'tray',highlights:[{id:'77',title:'a/b'},{id:'78',title:'旅行'}]}));
 await w.check(new AbortController().signal);assert.ok(w.state.highlights.todo[0].retryAt);
 await w.check(new AbortController().signal);assert.ok(w.state.highlights.records['78']);assert.equal(w.state.highlights.baseline,false);
 assert.equal(f.log.find(x=>x.event==='CATALOG_CHECK_FAILED').scope,'highlight:77');
});
test('schema failure preserves pagination checkpoint and emits issue; corrupt state fails closed',async t=>{
 const f=fixture(t,{fetcher:async()=>wrap({kind:'posts',posts:[{id:'oops'}],hasNext:false})});
 f.watch.state.highlights.nextAt=Date.now()+1e9;
 await f.watch.check(new AbortController().signal);
 assert.equal(f.watch.state.posts.cursor,null);assert.equal(Object.keys(f.watch.state.posts.records).length,0);
 const row=f.log.find(x=>x.event==='CATALOG_CHECK_FAILED');assert.deepEqual(eventIssue(row),['catalog-fetch:posts','CATALOG_INVALID_POST']);
 fs.writeFileSync(f.watch.file,'{');assert.throws(()=>new CatalogWatcher(f.args),/HISTORY_READ/);
});
test('multi-page baseline remains quiet and repeated cursor cannot mark complete',async t=>{
 const f=fixture(t),w=f.watch;
 let plan={kind:'posts',cursor:null};w.ingest(plan,wrap(normalizeResponse(body([post('1')],true,'page2'),plan,'99')));
 assert.equal(w.state.posts.baseline,false);assert.equal(w.state.posts.cursor,'page2');
 plan={kind:'posts',cursor:'page2'};w.ingest(plan,wrap(normalizeResponse(body([post('2')],false),plan,'99')));
 assert.equal(w.state.posts.baseline,true);assert.ok(Object.values(w.state.assets).every(a=>a.telegramDone));
 assert.equal(w.state.posts.records['2'].index,2);
});

test('failed captions rotate so later captions can still be saved', async t => {
 const f=fixture(t),w=f.watch;
 // A regular file in place of a directory makes the first ten writes fail.
 fs.writeFileSync(path.join(f.media,'posts'),'blocked');
 for(let i=0;i<10;i++) w.state.captions[String(i)]={file:`posts/${i}/caption.txt`,text:'blocked',hash:'blocked'};
 w.state.captions['10']={file:'highlight/later/caption.txt',text:'later',hash:'later'};
 await w.deliver(new AbortController().signal,async()=>{});
 assert.equal(w.state.captions['10'].savedHash,undefined);
 const restarted=new CatalogWatcher(f.args);
 await restarted.deliver(new AbortController().signal,async()=>{});
 assert.equal(fs.readFileSync(path.join(f.media,'highlight/later/caption.txt'),'utf8'),'later');
 assert.equal(restarted.state.captions['10'].savedHash,'later');
});

test('profile pagination accepts confirmed coauthors but rejects invitations and unrelated owners', () => {
 const collaboration=post();collaboration.user={pk:'77247833372'};collaboration.coauthor_producers=[{id:'99'}];
 const plan={kind:'posts',cursor:'page-two'};
 assert.equal(normalizeResponse(body([collaboration]),plan,'99').posts.length,1);
 collaboration.coauthor_producers=[{pk:'99'}];
 assert.equal(normalizeResponse(body([collaboration]),plan,'99').posts.length,1);
 collaboration.coauthor_producers=[{id:'123'}];collaboration.invited_coauthor_producers=[{id:'99'}];
 assert.throws(()=>normalizeResponse(body([collaboration]),plan,'99'),/OWNER_MISMATCH/);
 delete collaboration.user;collaboration.coauthor_producers=[{id:'99'}];
 assert.throws(()=>normalizeResponse(body([collaboration]),plan,'99'),/OWNER_MISMATCH/);
 const tray={data:{highlights:{edges:[{node:{id:'highlight:77',title:'x',user:{pk:'123'},coauthor_producers:[{id:'99'}]}}],page_info:{has_next_page:false,has_previous_page:false}}}};
 assert.throws(()=>normalizeResponse(tray,{kind:'tray'},'99'),/OWNER_MISMATCH/);
});
