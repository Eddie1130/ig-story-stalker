import { validMediaUrl } from './story-media.mjs';
import { validUsername } from './telegram-settings.mjs';
import { shortcodeId } from './instagram-links.mjs';

export function bestMedia(item, fallbackTime) {
  const id = String(item?.pk ?? item?.id ?? ''), mediaType = Number(item?.media_type);
  const takenAt = Number(item?.taken_at ?? fallbackTime);
  if (!/^\d+(?:_\d+)?$/.test(id) || ![1, 2].includes(mediaType) || !Number.isFinite(takenAt) || takenAt <= 0) throw Error('MANUAL_MEDIA_SCHEMA');
  const variants = mediaType === 2 ? item.video_versions : item.image_versions2?.candidates;
  const quality = v => (Number(v.width) || 0) * (Number(v.height) || 0);
  const best = Array.isArray(variants) ? [...variants].filter(v => v && validMediaUrl(v.url)).sort((a,b) => quality(b) - quality(a) || Number(b.bitrate || 0) - Number(a.bitrate || 0))[0] : null;
  if (!best) throw Error('MANUAL_MEDIA_UNAVAILABLE');
  const result = { id, mediaType, takenAt, mediaUrl: best.url, width: best.width || null, height: best.height || null };
  const dash = item.manualDash;
  if (mediaType === 2 && dash?.video && dash?.audio && validMediaUrl(dash.video.url) && validMediaUrl(dash.audio.url) &&
      (quality(dash.video) > quality(best) || (quality(dash.video) === quality(best) && Number(dash.video.bitrate || 0) > Number(best.bitrate || 0)))) {
    result.dash = dash; result.width = dash.video.width; result.height = dash.video.height;
  }
  return result;
}
export function normalizeManual(body, spec, target) {
  let owner, items, caption = '', contentId = spec.contentId, kind = spec.kind;
  if (kind === 'post') {
    if (!Array.isArray(body.items) || body.items.length !== 1) throw Error('MANUAL_POST_SCHEMA');
    const post = body.items[0];
    if (String(post.pk ?? post.id ?? '').split('_')[0] !== shortcodeId(spec.shortcode)) throw Error('MANUAL_TARGET_MISMATCH');
    owner = post.user; contentId = shortcodeId(spec.shortcode);
    if (Number(post.media_type) === 8) {
      items = post.carousel_media;
      if (!Array.isArray(items) || !items.length || (post.carousel_media_count != null && Number(post.carousel_media_count) !== items.length)) throw Error('MANUAL_CAROUSEL_INCOMPLETE');
    } else items = [post];
    caption = typeof post.caption === 'string' ? post.caption : post.caption?.text || '';
    items = items.map(i => bestMedia(i, post.taken_at));
  } else if (kind === 'story') {
    const reels = body.data?.xdt_api__v1__feed__reels_media?.reels_media;
    if (!Array.isArray(reels)) throw Error('MANUAL_STORY_SCHEMA');
    const reel = reels.find(r => String(r.id ?? r.user?.pk) === target);
    if (!reel || !Array.isArray(reel.items)) throw Error('MANUAL_STORY_UNAVAILABLE');
    owner = reel.user;
    const item = reel.items.find(i => String(i.pk ?? i.id ?? '').split('_')[0] === spec.contentId);
    if (!item) throw Error('MANUAL_STORY_UNAVAILABLE');
    items = [bestMedia(item)];
    if (String(owner?.pk ?? owner?.id) !== target || owner?.username?.toLowerCase() !== spec.username) throw Error('MANUAL_TARGET_MISMATCH');
  } else if (kind === 'highlight') {
    const conn = body.data?.xdt_api__v1__feed__reels_media__connection;
    if (!Array.isArray(conn?.edges) || conn.edges.length !== 1 || conn.page_info?.has_next_page !== false || conn.page_info?.has_previous_page !== false) throw Error('MANUAL_HIGHLIGHT_INCOMPLETE');
    const reel = conn.edges[0]?.node;
    if (String(reel?.id).replace(/^highlight:/, '') !== spec.contentId || !Array.isArray(reel.items)) throw Error('MANUAL_TARGET_MISMATCH');
    owner = reel.user; caption = typeof reel.title === 'string' ? reel.title : '';
    items = reel.items.map(i => bestMedia(i));
  } else throw Error('MANUAL_UNSUPPORTED_LINK');
  const username = owner?.username?.toLowerCase(), ownerId = String(owner?.pk ?? owner?.id ?? '');
  if (!validUsername(username) || !/^\d+$/.test(ownerId) || typeof caption !== 'string' || !items.length || new Set(items.map(i => i.id)).size !== items.length) throw Error('MANUAL_RESULT_SCHEMA');
  return { version: 1, kind, contentId, identity: spec.identity, username, ownerId, caption, media: items, url: spec.url };
}

// Runs inside Chromium. MPD text is parsed as XML data; it is never navigated to.
export function enrichDash(items) {
  for (const item of items) {
    const nested = item.carousel_media || [item];
    for (const media of nested) {
      if (typeof media.video_dash_manifest !== 'string') continue;
      const doc = new DOMParser().parseFromString(media.video_dash_manifest, 'application/xml');
      if (doc.querySelector('parsererror')) continue;
      const video = [], audio = [];
      for (const rep of doc.querySelectorAll('Representation')) {
        const set = rep.parentElement;
        const mime = rep.getAttribute('mimeType') || set?.getAttribute('mimeType') || '';
        const type = rep.getAttribute('contentType') || set?.getAttribute('contentType') || mime.split('/')[0];
        const url = rep.querySelector('BaseURL')?.textContent?.trim();
        if (!url || !['video', 'audio'].includes(type) || rep.querySelector('SegmentTemplate') || set?.querySelector(':scope > SegmentTemplate')) continue;
        const value = { url, width: Number(rep.getAttribute('width')) || 0, height: Number(rep.getAttribute('height')) || 0, bitrate: Number(rep.getAttribute('bandwidth')) || 0 };
        (type === 'video' ? video : audio).push(value);
      }
      video.sort((a,b) => b.width*b.height-a.width*a.height || b.bitrate-a.bitrate); audio.sort((a,b) => b.bitrate-a.bitrate);
      if (video[0] && audio[0]) media.manualDash = { video: video[0], audio: audio[0] };
    }
  }
  return items;
}
