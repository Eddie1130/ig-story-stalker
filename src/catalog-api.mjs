import { validMediaUrl } from './story-media.mjs';
export const POSTS_NAME = 'PolarisProfilePostsQuery';
export const PAGE_NAME = 'PolarisProfilePostsTabContentQuery_connection';
export const POST_DOC = '28322872020710458';
export const PAGE_DOC = '39535953862670189';
export const idOK = value => typeof value === 'string' && /^\d+(?:_\d+)?$/.test(value);
export const highlightId = value => {
  const id = String(value || '').replace(/^highlight:/, '');
  if (!/^\d+$/.test(id)) throw Error('CATALOG_INVALID_HIGHLIGHT_ID');
  return id;
};
export function makeRequest(plan, config) {
  if (!/^\d+$/.test(config.target) || !/^[A-Za-z0-9_.]{1,64}$/.test(config.username)) throw Error('CATALOG_INVALID_TARGET');
  if (plan.kind === 'posts') {
    if (plan.cursor !== null && (typeof plan.cursor !== 'string' || !plan.cursor || plan.cursor.length > 8192)) throw Error('CATALOG_INVALID_CURSOR');
    const variables = {
      data: {count:12,include_reel_media_seen_timestamp:true,include_relationship_info:true,latest_besties_reel_media:true,latest_reel_media:true},
      username: config.username,
      __relay_internal__pv__PolarisMultiCaptionCarouselEnabledrelayprovider:true,
      __relay_internal__pv__PolarisShortDramaEnabledrelayprovider:false,
      __relay_internal__pv__PolarisReelsRecoDebugOverlayEnabledrelayprovider:false,
    };
    if (plan.cursor) Object.assign(variables,{after:plan.cursor,before:null,first:12,last:null});
    return {method:'POST',path:'/graphql/query',friendly:plan.cursor?PAGE_NAME:POSTS_NAME,
      doc:plan.cursor?(config.pageDoc || PAGE_DOC):(config.postDoc || POST_DOC),variables,app:'936619743392459'};
  }
  if (plan.kind === 'tray') return {
    method:'POST',path:'/api/graphql',friendly:'PolarisProfileStoryHighlightsTrayContentQuery',
    doc:'26970053832668570',variables:{user_id:config.target},app:'936619743392459'
  };
  if (plan.kind === 'highlight') {
    const reel='highlight:'+highlightId(plan.id);
    return {method:'POST',path:'/graphql/query',friendly:'PolarisStoriesV3HighlightsPageQuery',
      doc:'39400183649572570',app:'936619743392459',
      rootField:'xdt_api__v1__feed__reels_media__connection',
      variables:{initial_reel_id:reel,reel_ids:[reel],first:3,last:2,
        __relay_internal__pv__PolarisCommunityNoteStoriesLabelEnabledrelayprovider:true}};
  }
  throw Error('CATALOG_INVALID_PLAN');
}
function optionalLocationImageError(body, error) {
  const path = error?.path;
  if (error?.message !== 'A server error field_exception occured. Check server logs for details.' || error.severity !== 'ERROR' ||
      !Array.isArray(path) || path.length !== 6 || path[0] !== 'xdt_api__v1__feed__user_timeline_graphql_connection' ||
      path[1] !== 'edges' || !Number.isSafeInteger(path[2]) || path[2] < 0 || path[3] !== 'node' ||
      path[4] !== 'location' || path[5] !== 'profile_pic_url') return false;
  const edges = body.data?.xdt_api__v1__feed__user_timeline_graphql_connection?.edges;
  return Array.isArray(edges) && !!edges[path[2]]?.node;
}
export function decodeResponse(result, { allowPostLocationImageError = false } = {}) {
  if (result.status !== 200) throw Error(`CATALOG_HTTP_${result.status}`);
  let body;
  try {body=JSON.parse(result.text.replace(/^\s*for\s*\(\s*;\s*;\s*\)\s*;\s*/,''));}
  catch {throw Error('CATALOG_NON_JSON_RESPONSE');}
  if (!body || typeof body !== 'object' || body.error || body.status === 'fail') throw Error('CATALOG_SERVER_OR_GRAPHQL_ERROR');
  // Location avatars are not archived. All required post/media fields still pass normalizeResponse's strict checks.
  if (body.errors !== undefined && (!Array.isArray(body.errors) ||
      body.errors.some(error => !allowPostLocationImageError || !optionalLocationImageError(body, error)))) throw Error('CATALOG_SERVER_OR_GRAPHQL_ERROR');
  return body;
}
function media(item, fallbackTime) {
  const id=String(item?.pk ?? item?.id ?? '');
  const type=Number(item?.media_type);
  const ts=Number(item?.taken_at ?? fallbackTime);
  if (!idOK(id) || ![1,2].includes(type) || !Number.isFinite(ts) || ts<=0) throw Error('CATALOG_MEDIA_SCHEMA_ERROR');
  const variants=type===2?item.video_versions:item.image_versions2?.candidates;
  const best=Array.isArray(variants)?variants.filter(v=>v && typeof v.url==='string').sort((a,b)=>(Number(b.width)||0)*(Number(b.height)||0)-(Number(a.width)||0)*(Number(a.height)||0) || (Number(b.bitrate)||0)-(Number(a.bitrate)||0))[0]:null;
  if (!best) throw Error(type===2?'CATALOG_VIDEO_VARIANT_MISSING':'CATALOG_IMAGE_VARIANT_MISSING');
  if (!validMediaUrl(best.url)) throw Error('CATALOG_UNEXPECTED_CDN_URL');
  return {id,mediaType:type,mediaUrl:best.url,takenAt:ts};
}
function owner(item,target,{coauthors=false}={}) {
  const user=item?.user;
  const id=String(user?.pk ?? user?.id ?? '');
  if (id===target) return;
  // Profile timelines include accepted collaboration posts owned by the other
  // producer. An invitation alone is not proof that the target owns the post.
  if (/^\d+$/.test(id) && coauthors && Array.isArray(item?.coauthor_producers) &&
      item.coauthor_producers.some(u=>String(u?.pk ?? u?.id ?? '')===target)) return;
  throw Error('CATALOG_OWNER_MISMATCH');
}
function unique(items) {if(new Set(items.map(x=>x.id)).size!==items.length) throw Error('CATALOG_DUPLICATE_IDS');return items;}
export function normalizeResponse(body,plan,target) {
  if(plan.kind==='posts') {
    const conn=body.data?.xdt_api__v1__feed__user_timeline_graphql_connection;
    if(!Array.isArray(conn?.edges) || typeof conn.page_info?.has_next_page!=='boolean') throw Error('CATALOG_POSTS_SCHEMA_ERROR');
    const posts=unique(conn.edges.map(edge=>{
      const p=edge?.node;owner(p,target,{coauthors:true});
      const id=String(p?.pk ?? p?.id ?? ''),takenAt=Number(p?.taken_at),type=Number(p?.media_type);
      if(!idOK(id)||!Number.isFinite(takenAt)||takenAt<=0||![1,2,8].includes(type)) throw Error('CATALOG_POST_SCHEMA_ERROR');
      const children=type===8?p.carousel_media:[p];
      if(!Array.isArray(children)||!children.length) throw Error('CATALOG_CAROUSEL_EMPTY');
      if(p.carousel_media_count!=null && Number(p.carousel_media_count)!==children.length) throw Error('CATALOG_CAROUSEL_INCOMPLETE');
      const caption=typeof p.caption==='string'?p.caption:p.caption?.text ?? '';
      if(typeof caption!=='string') throw Error('CATALOG_CAPTION_SCHEMA_ERROR');
      return {id,takenAt,caption,code:/^[A-Za-z0-9_-]+$/.test(p.code || p.shortcode || '')?(p.code || p.shortcode):null,media:unique(children.map(c=>media(c,takenAt)))};
    }));
    const more=conn.page_info.has_next_page,cursor=conn.page_info.end_cursor;
    if(more && (!posts.length||typeof cursor!=='string'||!cursor||cursor===plan.cursor)) throw Error('CATALOG_PAGINATION_INVALID');
    return {kind:'posts',posts,hasNext:more,cursor:more?cursor:null};
  }
  if(plan.kind==='tray') {
    const conn=body.data?.highlights;
    if(!Array.isArray(conn?.edges)) throw Error('CATALOG_TRAY_SCHEMA_ERROR');
    completeConnection(conn);
    return {kind:'tray',highlights:unique(conn.edges.map(edge=>{
      const h=edge?.node;
      owner(h,target);
      if(typeof h?.title!=='string' && h?.title!=null) throw Error('CATALOG_HIGHLIGHT_TITLE_ERROR');
      return {id:highlightId(h?.id),title:h.title||'highlight'};
    }))};
  }
  if(plan.kind!=='highlight') throw Error('CATALOG_INVALID_PLAN');
  const id=highlightId(plan.id);
  const conn=body.data?.xdt_api__v1__feed__reels_media__connection;
  if(!Array.isArray(conn?.edges)) throw Error('CATALOG_HIGHLIGHT_SCHEMA_ERROR');
  completeConnection(conn);
  const reels=unique(conn.edges.map(edge=>{
    const reel=edge?.node;
    owner(reel,target);
    return {...reel,id:highlightId(reel?.id)};
  }));
  const reel=reels.find(r=>r.id===id);
  if(!reel || !Array.isArray(reel.items)) throw Error('CATALOG_HIGHLIGHT_SCHEMA_ERROR');
  if(reels.length!==1) throw Error('CATALOG_UNEXPECTED_HIGHLIGHT_REELS');
  return {kind:'highlight',id,media:unique(reel.items.map(i=>media(i)))};
}
function completeConnection(conn) {
  if(typeof conn.page_info?.has_next_page!=='boolean' ||
     typeof conn.page_info?.has_previous_page!=='boolean')
    throw Error('CATALOG_CONNECTION_SCHEMA_ERROR');
  // Fail visibly rather than marking a partial collection as a complete baseline.
  if(conn.page_info.has_next_page || conn.page_info.has_previous_page)
    throw Error('CATALOG_HIGHLIGHTS_PAGINATION_REQUIRED');

}
// Permit only the one constructed read request, and only once. Do not broaden the
// Story guard or permit arbitrary GraphQL operations/REST POST requests.
export async function installCatalogGuard(context,spec) {
  const stats={allowedQuery:0,blockedReadReceipt:0,blockedWrite:0};
  await context.route('**/*',async route=>{
    const r=route.request(),url=new URL(r.url()),method=r.method().toUpperCase(),body=r.postData()||'';
    let decoded=body;try{decoded=decodeURIComponent(body);}catch{}
    if(/SeenMutation|MarkThreadAsRead|\/seen\/?|\/mark_seen\/?/i.test(url.pathname+' '+decoded)) {stats.blockedReadReceipt++;return route.abort('blockedbyclient');}
    if(['script','image','media','font','stylesheet'].includes(r.resourceType())) return route.abort('blockedbyclient');
    if(url.origin!=='https://www.instagram.com') return route.abort('blockedbyclient');
    let match=method===spec.method && url.pathname===spec.path && !url.search;
    if(match && spec.friendly) {
      const form=new URLSearchParams(body);
      let v;try{v=JSON.parse(form.get('variables'));}catch{}
      match=form.get('doc_id')===String(spec.doc) && form.get('fb_api_req_friendly_name')===spec.friendly && JSON.stringify(v)===JSON.stringify(spec.variables);
      const allowed=new Set(['__a','__d','__user','__comet_req','fb_api_caller_class','server_timestamps','lsd','fb_dtsg','jazoest','fb_api_req_friendly_name','doc_id','variables']);
      match=match && [...form.keys()].every(k=>allowed.has(k)) && [...form.keys()].length===new Set(form.keys()).size;
    } else if(match && spec.form) {
      match=body===new URLSearchParams(spec.form).toString();
    }
    if(match && stats.allowedQuery===0){stats.allowedQuery++;return route.continue();}
    if(method==='GET' && r.isNavigationRequest() && url.pathname==='/accounts/edit/' && !url.search) return route.continue();
    if(!['GET','HEAD'].includes(method)) stats.blockedWrite++;
    return route.abort('blockedbyclient');
  });
  return stats;
}
