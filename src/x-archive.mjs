import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { atomic } from './error-monitor.mjs';
import { mediaExtension } from './story-archive.mjs';
import { validXUsername, xKinds } from './x-model.mjs';

const validId = value => typeof value === 'string' && /^[1-9]\d{0,24}$/.test(value);
const accountBase = (username, manual = false) => `x/${manual ? 'manual/' : ''}${username}`;
export function validXMediaUrl(value) {
  try {
    const url = new URL(value);
    return !/^https:\/\/[^/]+:\d+(?:\/|$)/i.test(value) && url.protocol === 'https:' && !url.username && !url.password && !url.port && ['pbs.twimg.com', 'video.twimg.com'].includes(url.hostname);
  } catch { return false; }
}
function safePath(root, relative, { mkdir = false } = {}) {
  if (!path.isAbsolute(root) || typeof relative !== 'string' || !/^x\/(?:manual\/)?[a-z0-9_]{1,15}\/(?:media|posts)\//.test(relative) || relative.split(/[\\/]/).some(p => !p || p === '.' || p === '..') || relative.includes('\0')) throw Error('X_UNSAFE_PATH');
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
  if (!/^x\/(?:manual\/)?[a-z0-9_]{1,15}\/media\/[1-9]\d{0,24}_\d{2,4}\.(jpg|png|webp|mp4)$/.test(record.relativePath) || ![1, 2].includes(record.mediaType)) throw Error('X_UNSAFE_PATH');
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

function requireSameFile(left, right) {
  const a = fs.openSync(left, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let b;
  try {
    b = fs.openSync(right, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const aStat = fs.fstatSync(a), bStat = fs.fstatSync(b);
    if (aStat.size !== bStat.size) throw Error('X_ARCHIVE_CONFLICT');
    if (aStat.dev === bStat.dev && aStat.ino === bStat.ino) return;
    const aBuffer = Buffer.alloc(65536), bBuffer = Buffer.alloc(65536);
    for (let offset = 0; offset < aStat.size; offset += aBuffer.length) {
      const count = Math.min(aBuffer.length, aStat.size - offset);
      if (fs.readSync(a, aBuffer, 0, count, offset) !== count || fs.readSync(b, bBuffer, 0, count, offset) !== count || !aBuffer.subarray(0, count).equals(bBuffer.subarray(0, count))) throw Error('X_ARCHIVE_CONFLICT');
    }
  } finally { if (b !== undefined) fs.closeSync(b); fs.closeSync(a); }
}
function retainFile(root, record, relativePath) {
  const source = xFile(root, record), destination = safePath(root, relativePath, { mkdir: true });
  if (source !== destination) {
    try { fs.linkSync(source, destination); }
    catch (error) {
      if (error.code === 'EXDEV') {
        const temporary = destination + '.' + randomUUID() + '.tmp';
        try {
          fs.copyFileSync(source, temporary, fs.constants.COPYFILE_EXCL);
          requireSameFile(source, temporary);
          try { fs.linkSync(temporary, destination); } catch (linkError) { if (linkError.code !== 'EEXIST') throw linkError; }
        } finally { fs.rmSync(temporary, { force: true }); }
      } else if (error.code !== 'EEXIST') throw error;
    }
  }
  const retained = { ...record, relativePath };
  xFile(root, retained);
  requireSameFile(source, destination);
  return retained;
}
function writeIfMissing(file, text, compatible = actual => actual === text) {
  const temporary = file + '.' + randomUUID() + '.tmp';
  try {
    const descriptor = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(descriptor, text); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
    try { fs.linkSync(temporary, file); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16_000_000 || !compatible(fs.readFileSync(file, 'utf8'))) throw Error('X_ARCHIVE_CONFLICT');
    }
  } finally { fs.rmSync(temporary, { force: true }); }
}
function compatibleManifest(actual, result) {
  try {
    const previous = JSON.parse(actual).result;
    const identity = value => ({ username: value.username, contentId: value.contentId, kind: value.kind, url: value.url, caption: value.caption,
      files: value.files.map(file => ({ relativePath: file.relativePath, bytes: file.bytes, mediaType: file.mediaType })), errors: value.errors });
    return JSON.stringify(identity(previous)) === JSON.stringify(identity(result));
  } catch { return false; }
}

export class XArchive {
  constructor({ root, fetchImpl = fetch, maxBytes = 2_000_000_000, timeoutMs = 300000 }) {
    if (!path.isAbsolute(root) || !Number.isSafeInteger(maxBytes) || maxBytes < 12 || !Number.isFinite(timeoutMs) || timeoutMs <= 0) throw Error('X_INVALID_ARCHIVE_CONFIG');
    Object.assign(this, { root, fetchImpl, maxBytes, timeoutMs });
  }
  async download(username, item, { manual = false } = {}) {
    if (!validId(item.sourceId) || !Number.isSafeInteger(item.index) || item.index < 1 || item.index > 9999 || ![1, 2].includes(item.mediaType)) throw Error('X_INVALID_MEDIA');
    const filename = `${item.sourceId}_${String(item.index).padStart(2, '0')}`;
    const base = `${accountBase(username, manual)}/media/${filename}`;
    for (const extension of item.mediaType === 2 ? ['.mp4'] : ['.jpg', '.png', '.webp']) {
      const relativePath = base + extension, file = safePath(this.root, relativePath, { mkdir: true });
      if (!fs.existsSync(file)) continue;
      const bytes = fs.lstatSync(file).size, record = { relativePath, bytes, mediaType: item.mediaType };
      xFile(this.root, record);
      return { ...record, ...(item.width ? { width: item.width } : {}), ...(item.height ? { height: item.height } : {}) };
    }
    // Manual and background archives keep independent paths. Hardlinks reuse
    // immutable media bytes without moving files referenced by older receipts.
    for (const extension of item.mediaType === 2 ? ['.mp4'] : ['.jpg', '.png', '.webp']) {
      const relativePath = `${accountBase(username, !manual)}/media/${filename}${extension}`;
      let file;
      try { file = safePath(this.root, relativePath); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      if (!fs.existsSync(file)) continue;
      return retainFile(this.root, { relativePath, bytes: fs.lstatSync(file).size, mediaType: item.mediaType,
        ...(item.width ? { width: item.width } : {}), ...(item.height ? { height: item.height } : {}) }, base + extension);
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
      // Publishing via a link is exclusive; a concurrent/retained file is never
      // replaced. Validate the winner before returning its persisted identity.
      try { fs.linkSync(temporary, destination); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      xFile(this.root, { relativePath, bytes, mediaType: item.mediaType });
      requireSameFile(temporary, destination);
      return { relativePath, bytes, mediaType: item.mediaType, ...(item.width ? { width: item.width } : {}), ...(item.height ? { height: item.height } : {}) };
    } finally { fs.rmSync(temporary, { force: true }); }
  }
  async retainManual(result) {
    if (!validXUsername(result?.username) || !validId(result?.contentId) || !xKinds.includes(result?.kind) || typeof result.caption !== 'string' || typeof result.url !== 'string' || !Array.isArray(result.files) || !Array.isArray(result.errors) || result.files.length > 100) throw Error('X_INVALID_MANUAL_ARCHIVE');
    const base = accountBase(result.username, true), files = [];
    for (const record of result.files) {
      const prefix = `${accountBase(result.username)}/media/`, manualPrefix = `${base}/media/`;
      if (!record?.relativePath?.startsWith(prefix) && !record?.relativePath?.startsWith(manualPrefix)) throw Error('X_UNSAFE_PATH');
      files.push(retainFile(this.root, record, `${base}/media/${path.basename(record.relativePath)}`));
    }
    const retained = { ...result, files };
    const manifest = safePath(this.root, `${base}/posts/${result.contentId}.json`, { mkdir: true });
    const text = safePath(this.root, `${base}/posts/${result.contentId}.txt`, { mkdir: true });
    writeIfMissing(manifest, JSON.stringify({ version: 1, source: 'legacy-manual-event', result: retained }), actual => compatibleManifest(actual, retained));
    writeIfMissing(text, [retained.url, retained.caption].join('\n\n'));
    return retained;
  }
  async save(event, { manual = false } = {}) {
    if (!validXUsername(event?.targetUsername) || !validId(event?.statusId) || !validXUsername(event?.authorUsername) || !xKinds.includes(event?.kind) || !Array.isArray(event?.media) || event.media.length > 100 || Buffer.byteLength(JSON.stringify(event)) > 16_000_000) throw Error('X_INVALID_EVENT');
    if (typeof manual !== 'boolean') throw Error('X_INVALID_ARCHIVE_CONFIG');
    const username = event.targetUsername, base = accountBase(username, manual);
    const manifest = safePath(this.root, `${base}/posts/${event.statusId}.json`, { mkdir: true });
    const textFile = safePath(this.root, `${base}/posts/${event.statusId}.txt`, { mkdir: true });
    const files = [], errors = [], seen = new Set();
    for (const item of event.media) {
      const identity = `${item.sourceId}:${item.index}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      try { files.push(await this.download(username, item, { manual })); }
      catch (error) { errors.push({ sourceId: validId(item.sourceId) ? item.sourceId : null, index: item.index, reason: reason(error) }); }
    }
    const result = { username, kind: event.kind, contentId: event.statusId, url: event.url, caption: String(event.text || ''), files, errors };
    if (manual) {
      if (errors.length) return result;
      writeIfMissing(manifest, JSON.stringify({ version: 1, event, result }), actual => compatibleManifest(actual, result));
      writeIfMissing(textFile, [event.url, event.text].join('\n\n'));
      return result;
    }
    atomic(manifest, { version: 1, event, result });
    const temporary = textFile + '.' + randomUUID() + '.tmp';
    try { fs.writeFileSync(temporary, [event.url, event.text].join('\n\n'), { flag: 'wx', mode: 0o600 }); fs.renameSync(temporary, textFile); }
    finally { fs.rmSync(temporary, { force: true }); }
    return result;
  }
}
