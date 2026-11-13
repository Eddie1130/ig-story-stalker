export const xKinds = ['post', 'repost', 'reply', 'quote'];
export const validXUsername = name => typeof name === 'string' && /^[a-z0-9_]{1,15}$/.test(name);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const reserved = new Set(['home', 'explore', 'search', 'settings', 'messages', 'notifications', 'i', 'intent', 'login', 'logout', 'signup', 'share', 'compose', 'privacy', 'tos']);
const handle = value => String(value || '').replace(/^@/, '').toLowerCase();
function id(value) {
  // Reject numeric IDs: precision might already have been lost by JSON parsing.
  if (typeof value !== 'string' || !/^[1-9]\d{0,24}$/.test(value)) throw Error('X_INVALID_STATUS_ID');
  return value;
}
function username(value) { const name = handle(value); if (!validXUsername(name)) throw Error('X_INVALID_USERNAME'); return name; }

export function parseXLink(value) {
  if (typeof value !== 'string' || /[\\\s]/.test(value) || /^https:\/\/[^/]+:\d+(?:\/|$)/i.test(value) || /\/(?:\.|%2e){1,2}(?:\/|%2f|$)/i.test(value)) throw Error('X_INVALID_LINK');
  let url;
  try { url = new URL(value); } catch { throw Error('X_INVALID_LINK'); }
  const hostname = url.hostname.replace(/^(?:www|mobile|m)\./, '');
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !['x.com', 'twitter.com', 'fxtwitter.com'].includes(hostname)) throw Error('X_INVALID_LINK');
  const match = /^\/([A-Za-z0-9_]{1,15})(?:\/status\/([1-9]\d{0,24}))?\/?$/.exec(url.pathname);
  if (!match || reserved.has(match[1].toLowerCase())) throw Error('X_INVALID_LINK');
  const name = match[1].toLowerCase();
  return match[2] ? { kind: 'post', username: name, statusId: match[2], url: `https://x.com/${name}/status/${match[2]}` }
    : { kind: 'profile', username: name, url: `https://x.com/${name}` };
}

export function xLinks(text) {
  const urls = String(text).match(/https?:\/\/[^\s<>]+/gi) || [];
  const relevant = urls.filter(value => {
    try { return /^(?:(?:www|mobile|m)\.)?(?:x\.com|twitter\.com|fxtwitter\.com)$/i.test(new URL(value).hostname); } catch { return false; }
  });
  if (relevant.length > 10) throw Error('X_TOO_MANY_LINKS');
  return relevant.map(value => parseXLink(value.replace(/[),.!?;]+$/, '')));
}

function timestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value >= 1e12 ? value : value * 1000;
  if (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value)) return timestamp(Number(value));
  const ms = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? ms : null;
}
function originalPhoto(value) {
  try { const url = new URL(value); if (url.hostname === 'pbs.twimg.com') url.searchParams.set('name', 'orig'); return url.href; }
  catch { return String(value || ''); }
}
function bestVideo(video) {
  const variants = (Array.isArray(video?.variants) ? video.variants : [])
    .filter(v => object(v) && typeof v.url === 'string' && (/mp4/i.test(v.content_type || v.contentType || '') || /\.mp4(?:\?|$)/i.test(v.url)))
    .sort((a, b) => Number(b.bitrate || 0) - Number(a.bitrate || 0));
  return variants[0]?.url || video?.best_url || video?.video_url || video?.url || null;
}
function mediaBlock(media, sourceId) {
  if (!object(media)) return [];
  let rows;
  if (Array.isArray(media.all)) rows = media.all;
  else if (Array.isArray(media.ordered)) rows = media.ordered;
  else rows = [...(media.photos || media.images || []).map(photo => typeof photo === 'string' ? { type: 'photo', url: photo } : { ...photo, type: 'photo' }),
    ...(media.videos || []).map(video => ({ ...video, type: 'video' })), ...(media.animated_gifs || []).map(video => ({ ...video, type: 'video' }))];
  // Python's historical format groups images/videos. Per-type identities allow
  // that format to reuse Fx's interleaved media without shifting later files.
  let photoIndex = 0, videoIndex = 1000;
  return rows.map(row => {
    if (!object(row)) throw Error('X_INVALID_MEDIA');
    const mediaType = ['photo', 'image'].includes(row.type) ? 1 : ['video', 'gif', 'animated_gif'].includes(row.type) ? 2 : null;
    if (!mediaType) throw Error('X_UNSUPPORTED_MEDIA');
    const url = mediaType === 1 ? originalPhoto(row.url) : bestVideo(row);
    if (typeof url !== 'string' || !url) throw Error('X_INVALID_MEDIA');
    return { url, mediaType, sourceId, index: mediaType === 1 ? ++photoIndex : ++videoIndex, ...(Number.isFinite(row.width) ? { width: row.width } : {}), ...(Number.isFinite(row.height) ? { height: row.height } : {}) };
  });
}
function collectFxMedia(post) {
  const result = mediaBlock(post.media, id(post.id));
  if (object(post.quote) && post.quote.id) result.push(...mediaBlock(post.quote.media, id(post.quote.id)));
  return result;
}
function fxEvent(post, target, { manual = false } = {}) {
  if (!object(post)) throw Error('X_INVALID_STATUS');
  const statusId = id(post.id), author = username(post.author?.screen_name);
  const reposter = handle(post.reposted_by?.screen_name), repost = reposter === target;
  if (!manual && !repost && author !== target) return null;
  const rawText = String(post.raw_text?.text ?? post.text ?? '');
  const isReply = !!post.replying_to?.status || (Number(post.raw_text?.display_text_range?.[0]) > 0 && /^@[A-Za-z0-9_]+(?:\s|$)/.test(rawText));
  const kind = repost ? 'repost' : isReply ? 'reply' : post.quote ? 'quote' : 'post';
  return { targetUsername: target, statusId, authorUsername: author, kind, text: String(post.text ?? rawText),
    url: `https://x.com/${author}/status/${statusId}`, publishedAt: timestamp(post.created_timestamp ?? post.created_at),
    media: collectFxMedia(post), raw: post };
}

export function normalizeFxTimeline(payload, targetUsername) {
  const target = username(targetUsername);
  if (!object(payload) || (payload.code !== undefined && ![200, 204].includes(Number(payload.code))) || !Array.isArray(payload.results)) throw Error('X_INVALID_TIMELINE_RESPONSE');
  const rows = payload.results.flatMap(row => {
    if (row?.type === 'thread') { if (!Array.isArray(row.statuses)) throw Error('X_INVALID_TIMELINE_RESPONSE'); return row.statuses; }
    return [row];
  });
  const output = [], seen = new Set();
  for (const row of rows) {
    if (row?.type && row.type !== 'status') continue;
    const event = fxEvent(row, target);
    if (event && !seen.has(`${event.kind}:${event.statusId}`)) { output.push(event); seen.add(`${event.kind}:${event.statusId}`); }
  }
  return output;
}

export function normalizeFxPost(payload, link) {
  if (!object(payload) || (payload.code !== undefined && Number(payload.code) !== 200) || link?.kind !== 'post') throw Error('X_INVALID_POST_RESPONSE');
  const event = fxEvent(payload.tweet, username(link.username), { manual: true });
  if (event.statusId !== link.statusId) throw Error('X_POST_ID_MISMATCH');
  return event;
}

export function normalizeHistory(record, targetUsername) {
  const target = username(targetUsername);
  if (!object(record) || username(record.username) !== target) throw Error('X_HISTORY_AUTHOR_MISMATCH');
  const repost = object(record.retweeted_tweet), source = repost ? record.retweeted_tweet : record;
  const statusId = id(source.id), author = username(source.username || target);
  const media = mediaBlock(historyMedia(source), statusId);
  const quote = source.quoted_tweet || (!repost && record.quoted_tweet);
  if (object(quote) && quote.id) media.push(...mediaBlock(quote.media, id(quote.id)));
  return { targetUsername: target, statusId, authorUsername: author,
    kind: repost ? 'repost' : record.is_reply ? 'reply' : quote ? 'quote' : 'post', text: String(source.text || ''),
    url: `https://x.com/${author}/status/${statusId}`, publishedAt: timestamp(source.date || record.date), media, raw: record };
}

function historyMedia(record) {
  if (Array.isArray(record.media?.all) || Array.isArray(record.media?.ordered)) return record.media;
  const raw = record.raw_twscrape;
  if (Array.isArray(raw?.media?.all) || Array.isArray(raw?.media?.ordered)) return raw.media;
  if (Array.isArray(raw?.extended_entities?.media)) return { all: raw.extended_entities.media.map(item => ({ ...item, url: item.media_url_https || item.media_url, variants: item.video_info?.variants })) };
  return record.media;
}
