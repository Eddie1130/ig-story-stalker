import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { validMediaUrl } from './story-media.mjs';
import { atomic } from './error-monitor.mjs';

const idOK = id => typeof id === 'string' && /^\d+(?:_\d+)?$/.test(id);
const object = v => v && typeof v === 'object' && !Array.isArray(v);
export function archiveReason(error) {
  if (/^NAS_[A-Z0-9_]+$/.test(error?.message || '')) return error.message;
  if (['ENOSPC', 'EDQUOT', 'EACCES', 'EPERM', 'EROFS', 'EIO', 'ENOENT', 'ENOTDIR'].includes(error?.code)) return `NAS_${error.code}`;
  if (['AbortError', 'TimeoutError'].includes(error?.name)) return 'NAS_DOWNLOAD_ABORTED_OR_TIMEOUT';
  return 'NAS_DOWNLOAD_NETWORK_OR_IO_ERROR';
}
export function archiveBase(story, target) {
  if (!idOK(story.id) || !/^\d+$/.test(target)) throw Error('NAS_INVALID_ID');
  const taken = Number.isFinite(story.takenAt) && story.takenAt > 0 ? story.takenAt * 1000 : story.detectedAt;
  const d = new Date(taken + 9 * 3600000);
  if (!Number.isFinite(d.getTime())) throw Error('NAS_INVALID_TIME');
  const stamp = d.toISOString().slice(0, 19);
  return path.join('stories', `${stamp.slice(0, 10).replaceAll('-', '')}_${stamp.slice(11).replaceAll(':', '')}_JST_${story.id}`);
}
export function mediaExtension(bytes, type) {
  if (type === 2 && bytes.length >= 12 && bytes.toString('ascii', 4, 8) === 'ftyp') return '.mp4';
  if (type === 1) {
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return '.jpg';
    if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return '.png';
    if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return '.webp';
  }
  throw Error('NAS_UNEXPECTED_MEDIA_CONTENT');
}
// All redirects are checked before following. Never send session cookies to the CDN.
export async function downloadStory(root, base, story, { signal, fetchImpl = fetch, timeoutMs = 60000, maxBytes = 512 * 1024 * 1024 } = {}) {
  const destination = path.resolve(root, base);
  if (!destination.startsWith(path.resolve(root) + path.sep)) throw Error('NAS_INVALID_PATH');
  const folder = path.dirname(destination);
  await fsp.mkdir(folder, { recursive: true, mode: 0o755 });
  // Only complete, atomically renamed files can have these names. Recover after a crash
  // between file rename and state commit without downloading the same Story again.
  for (const ext of story.mediaType === 2 ? ['.mp4'] : ['.jpg', '.png', '.webp']) {
    let handle;
    try {
      handle = await fsp.open(destination + ext, 'r');
      const stat = await handle.stat();
      const bytes = Buffer.alloc(32); const { bytesRead } = await handle.read(bytes, 0, 32, 0);
      if (!stat.isFile() || stat.size < 12 || mediaExtension(bytes.subarray(0, bytesRead), story.mediaType) !== ext) throw Error('NAS_EXISTING_FILE_INVALID');
      return { relativePath: base + ext, bytes: stat.size, reused: true };
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
    finally { await handle?.close(); }
  }
  // One worker owns this queue. Remove only this Story's interrupted temporary file.
  const tmp = destination + '.part';
  let handle;
  try {
    await fsp.rm(tmp, { force: true });
    const combined = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(timeoutMs)]);
    let url = story.mediaUrl, response;
    for (let redirects = 0; ; redirects++) {
      if (!validMediaUrl(url)) throw Error('NAS_UNEXPECTED_CDN_URL');
      response = await fetchImpl(url, { redirect: 'manual', signal: combined, headers: { 'accept-encoding': 'identity' } });
      if (![301,302,303,307,308].includes(response.status)) break;
      await response.body?.cancel();
      if (redirects >= 3) throw Error('NAS_TOO_MANY_REDIRECTS');
      const location = response.headers.get('location');
      if (!location) throw Error('NAS_INVALID_REDIRECT');
      url = new URL(location, url).href;
    }
    if (response.status !== 200) { await response.body?.cancel(); throw Error(`NAS_HTTP_${response.status}`); }
    const encoding = response.headers.get('content-encoding');
    const length = response.headers.get('content-length');
    const expected = length === null ? null : Number(length);
    if ((encoding && encoding !== 'identity') || (expected !== null && (!Number.isSafeInteger(expected) || expected <= 0 || expected > maxBytes))) {
      await response.body?.cancel(); throw Error('NAS_INVALID_CONTENT_LENGTH_OR_ENCODING');
    }
    if (!response.body) throw Error('NAS_EMPTY_RESPONSE');
    let bytes = 0, prefix = Buffer.alloc(0);
    const meter = new Transform({ transform(chunk, enc, callback) {
      bytes += chunk.length;
      if (bytes > maxBytes) return callback(Error('NAS_FILE_TOO_LARGE'));
      if (prefix.length < 32) prefix = Buffer.concat([prefix, chunk.subarray(0, 32 - prefix.length)]);
      callback(null, chunk);
    }});
    await pipeline(Readable.fromWeb(response.body), meter, fs.createWriteStream(tmp, { flags: 'wx', mode: 0o644 }), { signal: combined });
    if (bytes < 12 || (expected !== null && expected !== bytes)) throw Error('NAS_INCOMPLETE_DOWNLOAD');
    const ext = mediaExtension(prefix, story.mediaType);
    handle = await fsp.open(tmp, 'r+'); await handle.sync(); await handle.close(); handle = null;
    await fsp.rename(tmp, destination + ext);
    const directory = await fsp.open(folder, 'r');
    try { await directory.sync(); } finally { await directory.close(); }
    return { relativePath: base + ext, bytes, reused: false };
  } finally {
    await handle?.close();
    await fsp.rm(tmp, { force: true });
  }
}
export class StoryArchive {
  constructor({ root, stateDir, target, log, download = downloadStory }) {
    if (!path.isAbsolute(root)) throw Error('NAS_ROOT_MUST_BE_ABSOLUTE');
    this.root = root; this.target = target; this.log = log; this.download = download;
    this.file = path.join(stateDir, `archive-${target}.json`);
    this.required = this.file + '.required';
    if (fs.existsSync(this.required) && !fs.existsSync(this.file)) throw Error('NAS_HISTORY_FILE_MISSING');
    try { this.state = JSON.parse(fs.readFileSync(this.file, 'utf8')); }
    catch (e) {
      if (e.code !== 'ENOENT') throw Error('NAS_HISTORY_READ_OR_PARSE_FAILED');
      this.state = { version: 1, target, pending: {}, saved: {}, failed: {} };
    }
    const s = this.state;
    if (s.version !== 1 || s.target !== target || !object(s.pending) || !object(s.saved) || !object(s.failed)) throw Error('NAS_INVALID_HISTORY');
    for (const [id, story] of Object.entries(s.pending)) {
      if (!idOK(id) || id !== story?.id || !validMediaUrl(story.mediaUrl) || ![1,2].includes(story.mediaType) || !Number.isFinite(story.detectedAt)) throw Error('NAS_INVALID_PENDING');
      this.checkBase(story.archiveBase);
      story.archiveBase = archiveBase(story, this.target);
    }
    for (const [id, record] of Object.entries(s.saved)) {
      if (!idOK(id) || !object(record) || !Number.isSafeInteger(record.bytes) || record.bytes < 12) throw Error('NAS_INVALID_SAVED');
      this.checkBase(record.relativePath);
    }
    if (fs.existsSync(this.file)) this.markRequired();
  }
  checkBase(base) {
    if (typeof base !== 'string' || path.isAbsolute(base) || base.split(/[\\/]/).some(x => !x || x === '.' || x === '..')) throw Error('NAS_INVALID_HISTORY_PATH');
  }
  markRequired() { if (!fs.existsSync(this.required)) fs.writeFileSync(this.required, 'required', { flag: 'wx', mode: 0o600 }); }
  persist() { atomic(this.file, this.state); this.markRequired(); }
  enqueue(stories, now = Date.now()) {
    for (const item of stories) {
      if (!idOK(item.id) || !validMediaUrl(item.mediaUrl) || ![1,2].includes(item.mediaType)) throw Error('NAS_INVALID_STORY');
      if (this.state.saved[item.id]) continue;
      const old = this.state.pending[item.id];
      const story = { ...old, ...item, detectedAt: old?.detectedAt ?? now };
      story.archiveBase = old?.archiveBase ?? archiveBase(story, this.target);
      this.state.pending[item.id] = story;
      delete this.state.failed[item.id];
    }
    this.persist();
  }
  async run(signal, { limit = 5, budgetMs = 90000, shouldYield = () => false } = {}) {
    const started = Date.now();
    const probe = path.join(this.root, `.ig-write-test-${randomUUID()}`);
    try {
      // Do not create root: a missing mount must be a visible error.
      await fsp.writeFile(probe, '', { flag: 'wx', mode: 0o600 });
      await fsp.unlink(probe);
    } catch (e) { this.log('NAS_STORAGE_ERROR', { reason: archiveReason(e) }); return false; }
    this.log('NAS_STORAGE_OK');
    let ok = true, count = 0;
    const pending = Object.values(this.state.pending).sort((a,b) => Number(!!a.failures) - Number(!!b.failures) || (a.lastAttemptAt || 0) - (b.lastAttemptAt || 0));
    for (const story of pending) {
      if (signal?.aborted || shouldYield() || count >= limit || Date.now() - started >= budgetMs) break;
      if (Date.now() - story.detectedAt > 7 * 86400000) {
        this.state.failed[story.id] = { at: Date.now(), reason: story.error || 'NAS_RETRY_EXPIRED' };
        delete this.state.pending[story.id]; this.persist();
        this.log('STORY_ARCHIVE_RETIRED', { id: story.id }); ok = false; continue;
      }
      count++;
      this.log('STORY_ARCHIVE_STARTED', { id: story.id });
      let result;
      try {
        result = await this.download(this.root, story.archiveBase, story, { signal, timeoutMs: Math.min(60000, Math.max(1000, budgetMs - (Date.now() - started))) });
      } catch (e) {
        if (signal?.aborted) break;
        story.failures = (story.failures || 0) + 1; story.error = archiveReason(e); story.lastAttemptAt = Date.now();
        this.persist(); this.log('STORY_ARCHIVE_RETRY', { id: story.id, reason: story.error }); ok = false;
        continue;
      }
      // State failure must escape, not be mistaken for a network retry.
      this.state.saved[story.id] = { ...result, at: Date.now() };
      delete this.state.pending[story.id]; this.persist();
      this.log('STORY_ARCHIVE_SAVED', { id: story.id, ...result });
    }
    this.log('WATCH_ARCHIVE_STATUS', { pendingCount: Object.keys(this.state.pending).length, failedCount: Object.keys(this.state.failed).length, savedCount: Object.keys(this.state.saved).length });
    return ok && Object.keys(this.state.pending).length === 0 && Object.keys(this.state.failed).length === 0;
  }
}
