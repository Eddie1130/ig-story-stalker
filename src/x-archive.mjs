import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { atomic } from './error-monitor.mjs';
import { mediaExtension } from './story-archive.mjs';
import { validXUsername, xKinds } from './x-model.mjs';

const validId = value => typeof value === 'string' && /^[1-9]\d{0,24}$/.test(value);
export function validXMediaUrl(value) {
  try {
    const url = new URL(value);
    return !/^https:\/\/[^/]+:\d+(?:\/|$)/i.test(value) && url.protocol === 'https:' && !url.username && !url.password && !url.port && ['pbs.twimg.com', 'video.twimg.com'].includes(url.hostname);
  } catch { return false; }
}
function safePath(root, relative, { mkdir = false } = {}) {
  if (!path.isAbsolute(root) || typeof relative !== 'string' || !/^x\/[a-z0-9_]{1,15}\//.test(relative) || relative.split(/[\\/]/).some(p => !p || p === '.' || p === '..') || relative.includes('\0')) throw Error('X_UNSAFE_PATH');
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw Error('X_UNSAFE_PATH');
  let current = root;
  const parts = relative.split('/');
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    const directory = index < parts.length - 1;
    let stat;
    try { stat = fs.lstatSync(current); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (directory && mkdir) { fs.mkdirSync(current, { mode: 0o700 }); stat = fs.lstatSync(current); }
      else if (directory) throw error;
      else continue;
    }
    if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) throw Error('X_UNSAFE_PATH');
  }
  return current;
}
export function xFile(root, record) {
  const file = safePath(root, record?.relativePath);
  if (!/^x\/[a-z0-9_]{1,15}\/media\/[1-9]\d{0,24}_\d{2,4}\.(jpg|png|webp|mp4)$/.test(record.relativePath) || ![1, 2].includes(record.mediaType)) throw Error('X_UNSAFE_PATH');
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(descriptor), prefix = Buffer.alloc(32), count = fs.readSync(descriptor, prefix, 0, 32, 0);
    if (!stat.isFile() || !Number.isSafeInteger(record.bytes) || stat.size !== record.bytes || stat.size < 12) throw Error('X_FILE_INCOMPLETE');
    try { if (mediaExtension(prefix.subarray(0, count), record.mediaType) !== path.extname(file)) throw Error('X_FILE_INCOMPLETE'); }
    catch { throw Error('X_FILE_INCOMPLETE'); }
  } finally { fs.closeSync(descriptor); }
  return file;
}
function reason(error) {
  if (/^X_[A-Z0-9_]+$/.test(error.message || '')) return error.message;
  if (['ENOSPC', 'EDQUOT', 'EROFS', 'EIO', 'EACCES', 'EPERM'].includes(error.code)) return `X_STORAGE_${error.code}`;
  if (/Timeout|Abort/.test(error.name || '')) return 'X_DOWNLOAD_TIMEOUT';
  return 'X_DOWNLOAD_FAILED';
}

export class XArchive {
  constructor({ root, fetchImpl = fetch, maxBytes = 2_000_000_000, timeoutMs = 300000 }) {
    if (!path.isAbsolute(root) || !Number.isSafeInteger(maxBytes) || maxBytes < 12 || !Number.isFinite(timeoutMs) || timeoutMs <= 0) throw Error('X_INVALID_ARCHIVE_CONFIG');
    Object.assign(this, { root, fetchImpl, maxBytes, timeoutMs });
  }
  async download(username, item) {
    if (!validId(item.sourceId) || !Number.isSafeInteger(item.index) || item.index < 1 || item.index > 9999 || ![1, 2].includes(item.mediaType)) throw Error('X_INVALID_MEDIA');
    const base = `x/${username}/media/${item.sourceId}_${String(item.index).padStart(2, '0')}`;
    for (const extension of item.mediaType === 2 ? ['.mp4'] : ['.jpg', '.png', '.webp']) {
      const relativePath = base + extension, file = safePath(this.root, relativePath, { mkdir: true });
      if (!fs.existsSync(file)) continue;
      const bytes = fs.lstatSync(file).size, record = { relativePath, bytes, mediaType: item.mediaType };
      xFile(this.root, record);
      return { ...record, ...(item.width ? { width: item.width } : {}), ...(item.height ? { height: item.height } : {}) };
    }
    const temporary = safePath(this.root, `${base}.${randomUUID()}.part`, { mkdir: true });
    const signal = AbortSignal.timeout(this.timeoutMs);
    let url = item.url, response;
    try {
      for (let count = 0; ; count++) {
        if (!validXMediaUrl(url)) throw Error('X_UNEXPECTED_CDN_URL');
        response = await this.fetchImpl(url, { redirect: 'manual', signal, headers: { 'accept-encoding': 'identity' } });
        if (![301, 302, 303, 307, 308].includes(response.status)) break;
        await response.body?.cancel();
        if (count >= 3) throw Error('X_TOO_MANY_REDIRECTS');
        const location = response.headers.get('location');
        if (!location) throw Error('X_INVALID_REDIRECT');
        url = new URL(location, url).href;
      }
      if (response.status !== 200) { await response.body?.cancel(); throw Error(`X_HTTP_${response.status}`); }
      const length = response.headers.get('content-length'), expected = length === null ? null : Number(length);
      const encoding = response.headers.get('content-encoding');
      if ((encoding && encoding !== 'identity') || (expected !== null && (!Number.isSafeInteger(expected) || expected < 12 || expected > this.maxBytes))) {
        await response.body?.cancel(); throw Error('X_INVALID_CONTENT_LENGTH');
      }
      if (!response.body) throw Error('X_EMPTY_MEDIA');
      let bytes = 0, prefix = Buffer.alloc(0);
      const meter = new Transform({ transform: (chunk, _encoding, done) => {
        bytes += chunk.length;
        if (bytes > this.maxBytes) return done(Error('X_FILE_TOO_LARGE'));
        if (prefix.length < 32) prefix = Buffer.concat([prefix, chunk.subarray(0, 32 - prefix.length)]);
        done(null, chunk);
      } });
      await pipeline(Readable.fromWeb(response.body), meter, fs.createWriteStream(temporary, { flags: 'wx', mode: 0o600 }), { signal });
      if (bytes < 12 || (expected !== null && expected !== bytes)) throw Error('X_INCOMPLETE_DOWNLOAD');
      let extension;
      try { extension = mediaExtension(prefix, item.mediaType); } catch { throw Error('X_UNEXPECTED_MEDIA_CONTENT'); }
      const relativePath = base + extension, destination = safePath(this.root, relativePath);
      const descriptor = fs.openSync(temporary, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
      fs.renameSync(temporary, destination);
      return { relativePath, bytes, mediaType: item.mediaType, ...(item.width ? { width: item.width } : {}), ...(item.height ? { height: item.height } : {}) };
    } finally { fs.rmSync(temporary, { force: true }); }
  }
  async save(event) {
    if (!validXUsername(event?.targetUsername) || !validId(event?.statusId) || !validXUsername(event?.authorUsername) || !xKinds.includes(event?.kind) || !Array.isArray(event?.media) || event.media.length > 100 || Buffer.byteLength(JSON.stringify(event)) > 16_000_000) throw Error('X_INVALID_EVENT');
    const username = event.targetUsername, manifest = safePath(this.root, `x/${username}/posts/${event.statusId}.json`, { mkdir: true });
    const textFile = safePath(this.root, `x/${username}/posts/${event.statusId}.txt`, { mkdir: true });
    const files = [], errors = [], seen = new Set();
    for (const item of event.media) {
      const identity = `${item.sourceId}:${item.index}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      try { files.push(await this.download(username, item)); }
      catch (error) { errors.push({ sourceId: validId(item.sourceId) ? item.sourceId : null, index: item.index, reason: reason(error) }); }
    }
    const result = { username, kind: event.kind, contentId: event.statusId, url: event.url, caption: String(event.text || ''), files, errors };
    atomic(manifest, { version: 1, event, result });
    const temporary = textFile + '.' + randomUUID() + '.tmp';
    try { fs.writeFileSync(temporary, [event.url, event.text].join('\n\n'), { flag: 'wx', mode: 0o600 }); fs.renameSync(temporary, textFile); }
    finally { fs.rmSync(temporary, { force: true }); }
    return result;
  }
}
