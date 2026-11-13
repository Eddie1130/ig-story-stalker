import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { atomic, load } from './error-monitor.mjs';
import { albumPlan, ManualDelivery } from './manual-delivery.mjs';
import { videoAttributes, videoPreview } from './video-attributes.mjs';
import { parseXLink } from './x-model.mjs';
import { formatJST } from './time-jst.mjs';

const object = value => value && typeof value === 'object' && !Array.isArray(value);
const username = value => typeof value === 'string' && /^[a-z0-9_]{1,15}$/.test(value);
const userId = value => typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value);
const kinds = ['post', 'repost', 'reply', 'quote'];
const statusUrl = value => typeof value === 'string' && /^https:\/\/x\.com\/[A-Za-z0-9_]{1,15}\/status\/\d+$/.test(value);
const safeReason = error => /^[A-Z0-9_]+$/.test(error?.message || '') ? error.message : 'X_LOCAL_FILE_UNAVAILABLE';

function validateEvent(event) {
  if (!object(event) || event.version !== 1 || !['post', 'notice'].includes(event.type) || typeof event.id !== 'string' ||
      !event.id.length || event.id.length > 256 || !Number.isFinite(event.at) || !Array.isArray(event.recipients) ||
      event.recipients.some(r => !object(r) || !userId(r.userId) || (r.generation !== undefined && typeof r.generation !== 'string')) ||
      (event.username !== undefined && !username(event.username))) throw Error('X_EVENT_INVALID');
  if (event.type === 'notice') {
    if (typeof event.text !== 'string' || event.text.length > 100000) throw Error('X_EVENT_INVALID');
    return event;
  }
  const result = event.result;
  if (!username(event.username) || !kinds.includes(event.kind) || typeof event.statusId !== 'string' || !/^\d+$/.test(event.statusId) ||
      (event.manual !== undefined && typeof event.manual !== 'boolean') ||
      !object(result) || result.username !== event.username || typeof result.caption !== 'string' || result.caption.length > 1000000 ||
      !statusUrl(result.url) || !Array.isArray(result.files) || !Array.isArray(result.errors) || result.files.length > 1000 ||
      result.files.some(file => !object(file) || !Number.isSafeInteger(file.bytes) || file.bytes < 12 || ![1, 2].includes(file.mediaType) ||
        typeof file.relativePath !== 'string' || !(file.relativePath.startsWith(`x/${event.username}/media/`) || (event.manual && file.relativePath.startsWith(`x/manual/${event.username}/media/`))) ||
        file.relativePath.split(/[\\/]/).some(part => !part || part === '.' || part === '..') || file.relativePath.includes('\0'))) throw Error('X_EVENT_INVALID');
  if (event.manual && (!userId(event.userId) || typeof event.requestId !== 'string' || !new RegExp(`^${event.userId}-\\d+-\\d+$`).test(event.requestId))) throw Error('X_EVENT_INVALID');
  return event;
}

function validateState(state) {
  if (state?.version !== 1 || !object(state.receipts)) throw Error('X_DELIVERY_HISTORY_INVALID');
  for (const [key, entry] of Object.entries(state.receipts)) {
    if (!/^[a-f0-9]{64}$/.test(key) || !object(entry) || !Number.isSafeInteger(entry.nextText) || entry.nextText < 0 ||
        !Number.isSafeInteger(entry.nextGroup) || entry.nextGroup < 0 || !Number.isSafeInteger(entry.failures) || entry.failures < 0 ||
        (entry.retryAt !== undefined && (!Number.isFinite(entry.retryAt) || entry.retryAt < 0)) ||
        ['done','uncertain','reported','documents','captionMode'].some(field => entry[field] !== undefined && typeof entry[field] !== 'boolean') ||
        (entry.localError !== undefined && (typeof entry.localError !== 'string' || !/^[A-Z0-9_]+$/.test(entry.localError))) ||
        (entry.inflight !== undefined && (!object(entry.inflight) || !Number.isFinite(entry.inflight.at)))) throw Error('X_DELIVERY_HISTORY_INVALID');
  }
  return state;
}

export function xTextChunks(text) {
  const limit = 4000;
  const chunks = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(text.length, start + limit);
    // Avoid splitting a UTF-16 surrogate pair between Telegram messages.
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    chunks.push(text.slice(start, end)); start = end;
  }
  return chunks;
}

export class XDelivery {
  constructor({ root, dir, stateDir, settings, log = () => {} }) {
    Object.assign(this, { root, dir, stateDir, settings, log });
    this.file = path.join(dir, 'x-delivery.json');
    if (fs.existsSync(this.file + '.required') && !fs.existsSync(this.file)) throw Error('X_DELIVERY_HISTORY_MISSING');
    this.state = validateState(load(this.file, { version: 1, receipts: {} }));
    for (const entry of Object.values(this.state.receipts)) {
      if (entry.inflight) { entry.uncertain = true; delete entry.inflight; }
    }
    this.persist();
  }
  persist() {
    atomic(this.file, this.state);
    if (!fs.existsSync(this.file + '.required')) fs.writeFileSync(this.file + '.required', 'required', { flag: 'wx', mode: 0o600 });
  }
  eligible(event, recipient) {
    const settings = this.settings();
    if (!settings.allowedIds.includes(recipient.userId)) return false;
    const user = Object.hasOwn(settings.users, recipient.userId) ? settings.users[recipient.userId] : undefined;
    const sub = user?.xTargets && Object.hasOwn(user.xTargets, event.username) ? user.xTargets[event.username] : undefined;
    if (event.type === 'notice') return !event.username || !!sub;
    if (event.manual) {
      const request = settings.xRequests && Object.hasOwn(settings.xRequests, event.requestId) ? settings.xRequests[event.requestId] : undefined;
      if (recipient.userId !== event.userId || request?.type !== 'manual' || request.userId !== event.userId || request.username !== event.username) return false;
      try {
        const requested=parseXLink(request.url), delivered=parseXLink(event.result.url);
        return requested.kind === 'post' && requested.username === event.username && requested.statusId === event.statusId && delivered.statusId === event.statusId;
      } catch { return false; }
    }
    const preference = sub?.notifications[event.kind];
    return sub?.generation === recipient.generation && preference?.enabled === true && event.at >= sub.joinedAt && event.at >= preference.since;
  }
  async upload(group, result, userId, documents) {
    const { xFile } = await import('./x-archive.mjs');
    return ManualDelivery.prototype.upload.call({ root: this.root, fileResolver: xFile, probe: videoAttributes, preview: videoPreview }, group, result, userId, documents);
  }
  async send(client, entry, method, body, files, expectedCount, eligible) {
    try {
      const response = await client.call(method, body, { files, timeoutMs: this.uploadTimeoutMs || (files?.length ? client.baseUrl && client.baseUrl !== 'https://api.telegram.org' ? 3600000 : 180000 : undefined),
        beforeRequest: () => {
          if (!eligible()) throw Error('X_DELIVERY_CANCELLED');
          entry.inflight = { at: Date.now() }; this.persist();
        } });
      const receipts = Array.isArray(response) ? response : [response];
      if (receipts.length !== expectedCount || receipts.some(r => !Number.isSafeInteger(r?.message_id) || r.message_id < 1)) throw Error('X_DELIVERY_UNCERTAIN');
      delete entry.inflight; entry.failures = 0; delete entry.retryAt;
      return 'sent';
    } catch (error) {
      if (error.message === 'X_DELIVERY_CANCELLED') { entry.done = true; this.persist(); return 'cancelled'; }
      if (error.code || !/^(TELEGRAM_|X_DELIVERY_UNCERTAIN)/.test(error.message)) throw error;
      const rejected = /^(TELEGRAM_RETRY_WAIT|TELEGRAM_STOPPING|TELEGRAM_ERROR_(400|401|403|429))$/.test(error.message);
      if (rejected || !entry.inflight) {
        delete entry.inflight;
        entry.failures++;
        entry.retryAt = Math.max(client.rate?.retryAt || 0, Date.now() + 30000);
        if (entry.failures >= 3 && !/RETRY_WAIT|STOPPING|429/.test(error.message)) entry.localError = error.message;
        this.persist();
        return error.message === 'TELEGRAM_ERROR_400' ? 'rejected' : 'retry';
      }
      entry.uncertain = true; delete entry.inflight; this.persist();
      return 'uncertain';
    }
  }
  async report(client, event, recipient, entry, text) {
    if (entry.reported || !text) return true;
    const outcome = await this.send(client, entry, 'sendMessage', { chat_id: recipient.userId, text: text.slice(0, 4000), link_preview_options: { is_disabled: true } }, [], 1, () => this.eligible(event, recipient));
    if (outcome === 'retry' || outcome === 'rejected') return false;
    // An uncertain warning is also not automatically repeated.
    entry.reported = true; this.persist(); return true;
  }
  async deliver(client, event, recipient, entry, stopping) {
    if (entry.done || Date.now() < (entry.retryAt || 0)) return !entry.retryAt;
    if (!this.eligible(event, recipient)) { entry.done = true; this.persist(); return true; }
    const result = event.result;
    const text = event.type === 'notice' ? event.text : [
      `[${event.kind.toUpperCase()}] @${event.username}`,
      Number.isFinite(event.publishedAt) ? `${event.kind === 'repost' ? '原文時間' : '發表時間'}：${formatJST(event.publishedAt)}` : '',
      event.kind === 'repost' ? `偵測時間：${formatJST(event.at)}（非精確轉發時間）` : '',
      result.url, result.caption,
    ].filter(Boolean).join('\n');
    const plan = result ? albumPlan(result.files) : { groups: [], oversized: [] };
    // Existing receipts may already have sent text using the old delivery order.
    if (event.manual && plan.groups.length && entry.captionMode === undefined && entry.nextText === 0 && entry.nextGroup === 0) {
      entry.captionMode = true; this.persist();
    }
    const captionMode = entry.captionMode === true;
    let captionEnd = Math.min(text.length, 1024);
    if (captionEnd < text.length && /[\uD800-\uDBFF]/.test(text[captionEnd - 1])) captionEnd--;
    const caption = text.slice(0, captionEnd);
    const texts = xTextChunks(captionMode ? text.slice(captionEnd) : text);
    const sendTexts = async (chunks, allowLocalError = false) => {
      while (entry.nextText < chunks.length && !entry.uncertain && (!entry.localError || allowLocalError) && !stopping()) {
        if (!this.eligible(event, recipient)) return true;
        const outcome = await this.send(client, entry, 'sendMessage', { chat_id: recipient.userId, text: chunks[entry.nextText], link_preview_options: { is_disabled: true } }, [], 1, () => this.eligible(event, recipient));
        if (outcome === 'cancelled') return true;
        if (outcome === 'retry' || outcome === 'rejected') return false;
        if (outcome === 'uncertain') break;
        entry.nextText++; this.persist();
      }
      return true;
    };
    if (!captionMode && !await sendTexts(texts)) return false;
    while (entry.nextGroup < plan.groups.length && !entry.uncertain && !entry.localError && !stopping()) {
      if (!this.eligible(event, recipient)) return true;
      const group = plan.groups[entry.nextGroup];
      let upload;
      try { upload = await this.upload(group, result, recipient.userId, entry.documents === true); }
      catch (error) { entry.localError = safeReason(error); this.persist(); break; }
      if (captionMode) {
        const groupCaption = entry.nextGroup === 0 ? caption : '';
        if (upload.method === 'sendMediaGroup') {
          upload.body.media.forEach((item, index) => { if (index === 0 && groupCaption) item.caption = groupCaption; else delete item.caption; });
        } else if (groupCaption) upload.body.caption = groupCaption;
        else delete upload.body.caption;
      }
      const outcome = await this.send(client, entry, upload.method, upload.body, upload.files, group.length, () => this.eligible(event, recipient));
      if (outcome === 'cancelled') return true;
      if (outcome === 'rejected' && !entry.documents && group.some(file => file.type !== 'document')) {
        entry.documents = true; delete entry.retryAt; delete entry.localError; this.persist(); continue;
      }
      if (outcome === 'retry' || outcome === 'rejected') return false;
      if (outcome === 'uncertain') break;
      entry.nextGroup++; delete entry.documents; this.persist();
    }
    if (captionMode && !entry.uncertain && !stopping()) {
      const remaining = entry.nextGroup === 0 && entry.localError ? xTextChunks(text) : texts;
      if (!await sendTexts(remaining, true)) return false;
    }
    if (stopping()) return false;
    if (!this.eligible(event, recipient)) return true;
    const report = entry.uncertain ? `Telegram 傳送結果不明，已保留本機原檔，沒有自動重送。請確認收到的內容，需要時重新貼上連結。\n${result?.url || ''}` :
      entry.localError ? `X 內容未能完整傳送：${entry.localError}\n已保留本機檔案。\n${result?.url || ''}` :
        plan.oversized.length || result?.errors.length ? [
          plan.oversized.length ? `${plan.oversized.length} 個檔案過大，已下載但無法直接傳送。` : '',
          result.errors.length ? `${result.errors.length} 個媒體未能下載；其他可取得內容已回傳。` : '',
          `本機位置：downloads/x/${event.manual ? 'manual/' : ''}${event.username}/`, result.url,
        ].filter(Boolean).join('\n') : '';
    if (!await this.report(client, event, recipient, entry, report)) return false;
    entry.done = true; this.persist();
    this.log('X_DELIVERY_STATUS', { id: event.id, userId: recipient.userId, status: entry.uncertain ? 'uncertain' : entry.localError ? 'failed' : 'complete' });
    return true;
  }
  async drain(client, { stopping = () => false, limit = 20 } = {}) {
    const directory = path.join(this.stateDir, 'x/events');
    let names;
    try { names = fs.readdirSync(directory).filter(name => /^[a-f0-9]{64}\.json$/.test(name)); }
    catch (error) { if (error.code === 'ENOENT') return true; throw error; }
    let count = 0, ok = true;
    for (const name of names.sort()) {
      if (stopping() || count >= limit) break;
      const file = path.join(directory, name);
      if (fs.lstatSync(file).isSymbolicLink() || fs.statSync(file).size > 4000000) throw Error('X_EVENT_INVALID');
      const event = validateEvent(load(file, null));
      for (const recipient of event.recipients) {
        if (stopping() || count >= limit) break;
        const key = createHash('sha256').update(`${event.id}:${recipient.userId}`).digest('hex');
        const entry = this.state.receipts[key] ||= { nextText: 0, nextGroup: 0, failures: 0 };
        if (entry.done) continue;
        count++;
        ok = await this.deliver(client, event, recipient, entry, stopping) && ok;
      }
    }
    return ok;
  }
}
