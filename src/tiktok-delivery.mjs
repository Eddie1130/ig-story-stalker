import { updateNotice, noticeRecipients } from './telegram-notices.mjs';
import { mediaEnabled } from './telegram-settings.mjs';
import { tikTokContentKinds } from './tiktok-settings.mjs';
import { tikTokContentPlan, contentBody } from './tiktok-content-files.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { load } from './error-monitor.mjs';
import { XDelivery } from './x-delivery.mjs';
import { tikTokName } from './tiktok-settings.mjs';

// Reuse the established durable, per-recipient acknowledgement/uncertainty logic.
export class TikTokDelivery extends XDelivery {
  constructor(options) { super({ ...options, dir: path.join(options.dir, 'tiktok') }); this.uploadTimeoutMs = 3600000; }
  eligible(event, recipient) {
    const s = this.settings(), user = s.users[recipient.userId];
    if (event.requestId) {
      const r = s.tiktokRequests?.[event.requestId];
      return s.allowedIds.includes(recipient.userId) && r?.userId === recipient.userId && event.requestUrl === r.url;
    }
    if (event.kind === 'notice' && event.noticeKind === 'recovery' && s.allowedIds.includes(recipient.userId) && this.state.notices?.[JSON.stringify([recipient.userId, event.noticeKey])]) return true;
    const sub = Object.hasOwn(user?.tiktokTargets || {}, event.username) ? user.tiktokTargets[event.username] : null;
    if (!s.allowedIds.includes(recipient.userId) || sub?.generation !== recipient.generation) return false;
    if (event.kind === 'notice') return true;
    const preference = sub.notifications[event.kind];
    return mediaEnabled(user, event.at) && preference?.enabled && event.at >= sub.joinedAt && event.at >= preference.since;
  }
  async drain(client, { stopping = () => false, lane = 'all' } = {}) {
    const dir = path.join(this.stateDir, 'tiktok/events');
    fs.mkdirSync(dir, { recursive: true });
    let ok = true;
    let processed = 0;
    for (const name of fs.readdirSync(dir).filter(n => /^[a-f0-9]{64}\.json$/.test(n)).sort()) {
      if (stopping()) break;
      let event;
      try {
      event = load(path.join(dir, name), null);
      if (!event || !tikTokName(event.username) || !['start','video','notice', ...tikTokContentKinds].includes(event.kind) || !Number.isFinite(event.at) || !Array.isArray(event.recipients) || event.recipients.some(r => !/^[1-9]\d{0,19}$/.test(r?.userId) || typeof r.generation !== 'string') || typeof event.text !== 'string' || event.text.length > 100000 || !Array.isArray(event.files) || event.files.some(f => typeof f !== 'string')) throw Error('TIKTOK_EVENT_INVALID');
      if (lane === 'video' && event.kind !== 'video' || lane === 'notice' && !['notice', 'start'].includes(event.kind) || lane === 'content' && (!tikTokContentKinds.includes(event.kind) || event.kind === 'story') || lane === 'story' && event.kind !== 'story') continue;
      if (++processed > 100) break;
      event.recipients = noticeRecipients(this.state, event);
      for (const recipient of event.recipients) {
        const key = createHash('sha256').update(`${name}:${recipient.userId}:${recipient.generation}`).digest('hex');
        const entry = this.state.receipts[key] ||= { nextText: 0, nextGroup: 0, failures: 0 };
        if (entry.done || Date.now() < (entry.retryAt || 0)) continue;
        if (!this.eligible(event, recipient)) { entry.done = true; this.persist(); continue; }
        if (event.kind === 'notice' && typeof event.noticeKey === 'string') {
          try {
            await updateNotice(client, this.state, JSON.stringify([recipient.userId, event.noticeKey]), { at: event.at, userId: recipient.userId, text: event.text, recovery: event.noticeKind === 'recovery' }, () => this.persist());
            entry.done = true; delete entry.retryAt; this.persist();
          } catch (error) {
            if (!/^TELEGRAM_/.test(error.message)) throw error;
            entry.failures++; entry.retryAt = Date.now() + 30000; this.persist(); ok = false;
          }
          continue;
        }
        if (entry.uncertain) {
          const result = await this.send(client, entry, 'sendMessage', { chat_id: recipient.userId, text: `TikTok @${event.username} 傳送結果不確定，避免重複上傳；本機錄影保留。` }, [], 1, () => this.eligible(event, recipient));
          if (result === 'sent' || result === 'uncertain') { entry.done = true; this.persist(); }
          else ok = false;
          continue;
        }
        const content = tikTokContentKinds.includes(event.kind);
        const items = content ? tikTokContentPlan(event, this.root) : [null, ...event.files];
        for (let i = entry.nextGroup; i < items.length && !stopping(); i++) {
          let body = { chat_id: recipient.userId, text: event.text }, method = 'sendMessage';
          if (content) { method = items[i].method; body = { chat_id: recipient.userId, ...contentBody(this.root, event, items[i]) }; }
          else if (items[i]) {
            const relative = items[i];
            if (!relative.startsWith(`tiktok/${event.username}/live/`) || relative.split(/[\\/]/).some(p => !p || p === '.' || p === '..') || !relative.endsWith('.mp4')) throw Error('TIKTOK_FILE_INVALID');
            const root = fs.realpathSync(this.root), filename = fs.realpathSync(path.join(root, relative));
            if (!filename.startsWith(root + path.sep) || !fs.statSync(filename).isFile() || fs.statSync(filename).size > 2_000_000_000) throw Error('TIKTOK_FILE_INVALID');
            method = 'sendVideo';
            body = { chat_id: recipient.userId, video: 'file://' + filename, caption: `TikTok @${event.username}（${i}/${event.files.length}）`, supports_streaming: true };
          }
          const outcome = await this.send(client, entry, method, body, [], method === 'sendMediaGroup' ? body.media.length : 1, () => this.eligible(event, recipient));
          if (outcome !== 'sent') { ok = false; break; }
          entry.nextGroup = i + 1; this.persist();
        }
        if (entry.nextGroup === items.length) { entry.done = true; this.persist(); }
      }
      if (event.recipients.every(r => this.state.receipts[createHash('sha256').update(`${name}:${r.userId}:${r.generation}`).digest('hex')]?.done)) fs.unlinkSync(path.join(dir, name));
      } catch {
        ok = false;
        this.log('TIKTOK_DELIVERY_FAILED', { event: name, reason: 'TIKTOK_EVENT_OR_FILE_UNAVAILABLE' });
      }
    }
    return ok;
  }
}
