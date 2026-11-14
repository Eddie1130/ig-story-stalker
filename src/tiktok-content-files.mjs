import fs from 'node:fs';
import path from 'node:path';
import { xTextChunks } from './x-delivery.mjs';

function photoDimensions(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const bytes = Buffer.alloc(Math.min(65536, fs.statSync(file).size)); fs.readSync(fd, bytes, 0, bytes.length, 0);
    if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
    if (bytes[0] !== 255 || bytes[1] !== 216) return null;
    for (let at = 2; at + 8 < bytes.length;) {
      if (bytes[at] !== 255) return null;
      const marker = bytes[at + 1], length = bytes.readUInt16BE(at + 2);
      if ([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)) return [bytes.readUInt16BE(at + 7), bytes.readUInt16BE(at + 5)];
      if (length < 2) return null; at += 2 + length;
    }
    return null;
  } finally { fs.closeSync(fd); }
}
export function tikTokContentPlan(event, root) {
  const caption = typeof event.mediaCaption === 'string' && event.files.length ? event.mediaCaption.slice(0, 900) : undefined;
  const actions = xTextChunks(caption !== undefined ? '' : event.text).map(text => ({ method: 'sendMessage', body: { text } }));
  let group = [];
  const flush = () => {
    if (!group.length) return;
    if (caption !== undefined) group[0].caption = caption;
    if (group.length === 1) {
      const item = group[0];
      actions.push({ method: { photo: 'sendPhoto', video: 'sendVideo', document: 'sendDocument' }[item.type], body: { [item.type]: item.media, ...(item.caption !== undefined ? { caption: item.caption } : {}), ...(item.type === 'video' ? { supports_streaming: true } : {}) } });
    } else actions.push({ method: 'sendMediaGroup', body: { media: group } });
    group = [];
  };
  for (const file of event.files) {
    let type = /\.mp4$/.test(file) ? 'video' : 'document';
    if (root && /\.(jpg|png)$/.test(file)) {
      const url = contentBody(root, event, { body: { document: 'local:' + file } }).document;
      const filename = new URL(url);
      const dimensions = photoDimensions(filename);
      if (fs.statSync(filename).size <= 10_000_000 && dimensions && dimensions.every(n => n > 0) && dimensions[0] + dimensions[1] <= 10000 && Math.max(...dimensions) / Math.min(...dimensions) <= 20) type = 'photo';
    }
    if (group.length && (type === 'document') !== (group[0].type === 'document')) flush();
    group.push({ type, media: 'local:' + file, ...(type === 'video' ? { supports_streaming: true } : {}) });
    if (group.length === 10) flush();
  }
  flush();
  return actions;
}
export function contentBody(root, event, action) {
  const folder = event.archiveFolder || event.username;
  if (!/^[a-z0-9_][a-z0-9_.]{0,23}(?:_\d{1,30})?$/.test(folder)) throw Error('TIKTOK_FILE_INVALID');
  const category = { post: 'posts', repost: 'reposts', story: 'stories', profile: 'profile', like: 'likes' }[event.kind];
  const resolve = value => {
    if (!value?.startsWith('local:')) return value;
    const relative = value.slice(6);
    if (!category || !relative.startsWith(`tiktok/${folder}/${category}/`) || relative.includes('\0') || relative.split(/[\\/]/).some(p => !p || p === '.' || p === '..') || !/\.(mp4|jpg|png|webp)$/.test(relative)) throw Error('TIKTOK_FILE_INVALID');
    const base = fs.realpathSync(root), file = fs.realpathSync(path.join(base, relative)), stat = fs.statSync(file);
    if (!file.startsWith(base + path.sep) || !stat.isFile() || stat.size < 12 || stat.size > 2_000_000_000) throw Error('TIKTOK_FILE_INVALID');
    return 'file://' + file;
  };
  const body = structuredClone(action.body);
  if (body.media) for (const item of body.media) item.media = resolve(item.media);
  for (const key of ['photo', 'video', 'document']) if (body[key]) body[key] = resolve(body[key]);
  return body;
}
