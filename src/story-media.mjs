import { formatJST } from './time-jst.mjs';
export function validMediaUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && !u.username && !u.password &&
      (!u.port || u.port === '443') && /(^|\.)(cdninstagram\.com|fbcdn\.net)$/i.test(u.hostname);
  } catch { return false; }
}
export function buildMediaResult(items, targetUserId, username, reelId) {
  if (items.length && String(reelId) !== String(targetUserId)) throw new Error('MEDIA_REEL_TARGET_MISMATCH');
  const stories = [], skippedIds = [];
  for (const item of [...items].sort((a, b) => Number(a.taken_at || 0) - Number(b.taken_at || 0))) {
    const id = String(item.pk ?? item.id ?? '');
    if (!/^\d+(?:_\d+)?$/.test(id)) throw new Error('MEDIA_INVALID_STORY_ID');
    const isVideo = Number(item.media_type) === 2;
    const variants = isVideo ? item.video_versions : item.image_versions2?.candidates;
    const best = Array.isArray(variants) ? [...variants].sort((a, b) =>
      (Number(b.width) || 0) * (Number(b.height) || 0) - (Number(a.width) || 0) * (Number(a.height) || 0))[0] : null;
    if (!best?.url) { skippedIds.push(id); continue; }
    if (!validMediaUrl(best.url)) throw new Error('MEDIA_UNEXPECTED_CDN_URL');
    stories.push({ id, username, mediaType: isVideo ? 2 : 1, mediaUrl: best.url,
      width: best.width ?? null, height: best.height ?? null,
      takenAt: Number(item.taken_at) || null, expiringAt: Number(item.expiring_at) || null,
      hasAudio: item.has_audio ?? null });
  }
  return { version: 1, targetUserId: String(targetUserId), storyCount: stories.length, stories, skippedIds };
}
export function mediaRequest(story, chatId) {
  if (!validMediaUrl(story.mediaUrl)) throw new Error('MEDIA_INVALID_URL');
  const iso = Number.isFinite(story.takenAt) ? formatJST(story.takenAt * 1000) : '';
  const caption = [`@${story.username}`, `Story ${story.id}`, iso].filter(Boolean).join('\n');
  return story.mediaType === 2
    ? { method: 'sendVideo', body: { chat_id: chatId, video: story.mediaUrl, caption, supports_streaming: true } }
    : { method: 'sendPhoto', body: { chat_id: chatId, photo: story.mediaUrl, caption } };
}
export function enqueue(state, media, now = Date.now()) {
  for (const story of media.stories) {
    if (story.expiringAt && story.expiringAt * 1000 <= now) continue;
    if (Object.hasOwn(state.sent, story.id)) continue;
    // Refresh signed URLs while retaining failed delivery history.
    state.pending[story.id] = { ...state.pending[story.id], ...story,
      detectedAt: state.pending[story.id]?.detectedAt ?? now };
  }
  for (const [id, at] of Object.entries(state.sent)) if (now - at > 30 * 86400000) delete state.sent[id];
}
export async function deliver(state, send, persist, onSent, onError, stopping = () => false) {
  const pending = Object.values(state.pending).sort((a, b) =>
    Number((a.deliveryFailures || 0) > 0) - Number((b.deliveryFailures || 0) > 0) ||
    (a.takenAt || 0) - (b.takenAt || 0)).slice(0, 20);
  let failed = false;
  for (const story of pending) {
    if (stopping()) break;
    try { await send(story); }
    catch (error) {
      if (!error.message.startsWith('TELEGRAM_')) throw error;
      failed = true;
      if (error.message !== 'TELEGRAM_RETRY_WAIT') story.deliveryFailures = (story.deliveryFailures || 0) + 1;
      story.deliveryError = error.message;
      persist();
      onError(story.id, error.message);
      if (error.message === 'TELEGRAM_RETRY_WAIT' || /_(401|403|429)$/.test(error.message)) break;
      continue;
    }
    state.sent[story.id] = Date.now();
    delete state.pending[story.id];
    persist();
    onSent(story.id, story.mediaType);
  }
  return !failed;
}
