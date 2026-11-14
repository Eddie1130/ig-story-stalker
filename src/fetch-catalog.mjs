import { chromium } from 'playwright-core';
import fs from 'node:fs';
import { makeRequest, decodeResponse, normalizeResponse, installCatalogGuard } from './catalog-api.mjs';
const log=(event,data={})=>{
  const line=JSON.stringify({ts:new Date().toISOString(),event,...data});
  console.log(line);
  if(event==='CATALOG_OWNER_DIAGNOSTIC') {
    try { fs.appendFileSync('/app/logs/catalog-diagnostics.log',line+'\n',{mode:0o600}); }
    catch { console.log(JSON.stringify({ts:new Date().toISOString(),event:'CATALOG_DIAGNOSTIC_STORAGE_ERROR'})); }
  }
};
let context, stage='CONFIG';
try {
  log('CATALOG_REQUEST_VERSION',{version:'HIGHLIGHTS_GRAPHQL_V1'});
  const plan=JSON.parse(process.env.IG_CATALOG_PLAN || '{}');
  const config={target:process.env.IG_TARGET_USER_ID,username:process.env.IG_TARGET_USERNAME,postDoc:process.env.IG_POSTS_DOC_ID,pageDoc:process.env.IG_POSTS_PAGE_DOC_ID};
  const spec=makeRequest(plan,config);
  if(!/^\d+$/.test(spec.doc || '0')) throw Error('CATALOG_INVALID_DOC_ID');
  stage='BROWSER_START';
  context=await chromium.launchPersistentContext('/data/profile',{executablePath:'/usr/bin/chromium',headless:true,serviceWorkers:'block',args:['--no-sandbox','--disable-dev-shm-usage']});
  const guard=await installCatalogGuard(context,spec);
  const page=context.pages()[0] ?? await context.newPage();
  stage='BOOTSTRAP';
  const response=await page.goto('https://www.instagram.com/accounts/edit/',{waitUntil:'domcontentloaded',timeout:45000});
  const status=response?.status();
  const pathname=new URL(page.url()).pathname;
  if(/^\/(?:accounts\/login|challenge|checkpoint)(?:\/|$)/i.test(pathname)) throw Error('CATALOG_SESSION_INVALID');
  if(status!==200) throw Error(Number.isInteger(status)?`CATALOG_BOOTSTRAP_HTTP_${status}`:'CATALOG_BOOTSTRAP_HTTP_ERROR');
  if(pathname!=='/accounts/edit/') throw Error('CATALOG_BOOTSTRAP_UNEXPECTED_REDIRECT');
  stage='TOKENS';
  const tokens = await page.evaluate(() => {
    const csrfCookie = document.cookie
      .split(';')
      .map(c => c.trim())
      .find(c => c.startsWith('csrftoken='));

    const csrf = csrfCookie
      ? csrfCookie.slice('csrftoken='.length)
      : '';

    let lsd = '';

    for (const script of document.querySelectorAll('script')) {
      const text = script.textContent || '';

      const m1 = text.match(/"LSD",\[\],\{"token":"([^"]+)"/);
      if (m1) {
        lsd = m1[1];
        break;
      }

      const m2 = text.match(/"name":"LSD".*?"token":"([^"]+)"/);
      if (m2) {
        lsd = m2[1];
        break;
      }
    }

    // HAR_AUTH_V2
    let fbDtsg = '';
    for (const script of document.querySelectorAll('script')) {
      const text = script.textContent || '';
      const pattern =
        /"DTSGInitialData"\s*,\s*\[\s*\]\s*,\s*(\{[^}]*\})/g;

      for (const match of text.matchAll(pattern)) {
        try {
          const data = JSON.parse(match[1]);
          if (typeof data.token === 'string' && data.token) {
            fbDtsg = data.token;
            break;
          }
        } catch {}
      }
      if (fbDtsg) break;
    }

    return { csrf, lsd, fbDtsg };
  });
  if(!tokens.csrf || (spec.friendly && (!tokens.lsd||!tokens.fbDtsg))) throw Error('CATALOG_BOOTSTRAP_TOKEN_ERROR');
  stage='GRAPHQL';
  const result=await page.evaluate(async({spec,tokens})=>{
    const headers={'X-CSRFToken':tokens.csrf,'X-IG-App-ID':spec.app,'X-Requested-With':'XMLHttpRequest','Accept':'*/*'};
    if(spec.rootField) headers['X-Root-Field-Name']=spec.rootField;
    let body;
    if(spec.friendly){
      Object.assign(headers,{'Content-Type':'application/x-www-form-urlencoded','X-ASBD-ID':'359341','X-FB-Friendly-Name':spec.friendly,'X-FB-LSD':tokens.lsd});
      const form={__a:'1',__d:'www',__user:'0',__comet_req:'7',fb_api_caller_class:'RelayModern',server_timestamps:'true',lsd:tokens.lsd,fb_dtsg:tokens.fbDtsg,jazoest:'2'+[...tokens.fbDtsg].reduce((n,c)=>n+c.charCodeAt(0),0),fb_api_req_friendly_name:spec.friendly,doc_id:spec.doc,variables:JSON.stringify(spec.variables)};
      body=new URLSearchParams(form).toString();
    }else if(spec.form){headers['Content-Type']='application/x-www-form-urlencoded';body=new URLSearchParams(spec.form).toString();}
    const response=await fetch(spec.path,{method:spec.method,headers,body,credentials:'include',redirect:'error',signal:AbortSignal.timeout(45000)});
    return {status:response.status,text:await response.text()};
  },{spec,tokens});
  stage='RESPONSE';
  const decoded = decodeResponse(result, { allowPostLocationImageError: plan.kind === 'posts' });
  let normalized;
  try { normalized = normalizeResponse(decoded,plan,config.target); }
  catch (error) {
    if (error.message === 'CATALOG_OWNER_MISMATCH' && plan.kind === 'posts') {
      const numeric = value => /^\d+$/.test(String(value || '')) ? String(value) : null;
      log('CATALOG_OWNER_DIAGNOSTIC', { target: config.target, username: config.username,
        paginated: !!plan.cursor, owners: (decoded.data?.xdt_api__v1__feed__user_timeline_graphql_connection?.edges || []).slice(0, 12).map(edge => { const p=edge?.node; return ({
          post: numeric(p?.pk), owner: numeric(p?.user?.pk ?? p?.user?.id),
          coauthors: (Array.isArray(p?.coauthor_producers) ? p.coauthor_producers : []).map(u => numeric(u?.pk ?? u?.id)).filter(Boolean),
          invited: (Array.isArray(p?.invited_coauthor_producers) ? p.invited_coauthor_producers : []).map(u => numeric(u?.pk ?? u?.id)).filter(Boolean),
          ownerKeys: Object.keys(p?.user || {}).filter(k => /^[a-z_]+$/.test(k)).slice(0, 25),
        }); }) });
    }
    throw error;
  }
  if(guard.blockedReadReceipt || guard.allowedQuery!==1) throw Error('CATALOG_GUARD_INVARIANT_FAILED');
  fs.writeFileSync(process.env.IG_CATALOG_RESULT_FILE,JSON.stringify({version:1,target:config.target,guard,...normalized}),{mode:0o600,flag:'wx'});
  log('CATALOG_FETCH_SUCCESS',{kind:plan.kind,itemCount:(normalized.highlights||normalized.media||normalized.posts||[]).length,guard});
}catch(e){log('CATALOG_FETCH_ERROR',{reason:/^CATALOG_[A-Z0-9_]+$/.test(e.message)?e.message:`CATALOG_${stage}_BROWSER_OR_NETWORK_ERROR`});process.exitCode=1;}
finally{if(context)try{await context.close();}catch{log('CATALOG_FETCH_ERROR',{reason:'CATALOG_BROWSER_CLOSE_ERROR'});process.exitCode=1;}}
