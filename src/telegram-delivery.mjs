import fs from 'node:fs';
import path from 'node:path';
import { atomic, load } from './error-monitor.mjs';
import { userTarget, subscribed, alertRecipients, validUsername, kinds } from './telegram-settings.mjs';
import { mediaRequest, validMediaUrl } from './story-media.mjs';

const object = v => v && typeof v === 'object' && !Array.isArray(v);
export class PersonalDelivery {
  constructor({ dir, stateDir, settings, log = () => {} }) {
    Object.assign(this, { dir, stateDir, settings, log });
    this.file = path.join(dir, 'delivery.json');
    if (fs.existsSync(this.file + '.required') && !fs.existsSync(this.file)) throw Error('TELEGRAM_DELIVERY_HISTORY_MISSING');
    this.state = load(this.file, { version: 1, pending: {}, seen: {}, firstSeen: {}, initialized: {}, summaries: {}, legacyImported: false });
    const s = this.state;
    if (s.version !== 1 || ![s.pending, s.seen, s.firstSeen, s.initialized, s.summaries].every(object) || typeof s.legacyImported !== 'boolean') throw Error('TELEGRAM_DELIVERY_HISTORY_INVALID');
    if (!s.legacyImported) {
      const config = settings(), owner = config.users[config.ownerId];
      const layout = load(path.join(stateDir, 'archive-layout.json'), { accounts: {} });
      for (const [target, name] of Object.entries(layout.accounts || {})) {
        const sub = userTarget(owner, name); if (!sub) continue;
        const old = load(path.join(stateDir, `watch-media-${target}.json`), null);
        for (const [id, at] of Object.entries(old?.sent || {})) s.seen[this.key(config.ownerId, sub, name, 'story', id)] = at;
      }
      s.legacyImported = true;
    }
    this.persist();
  }
  persist() {
    atomic(this.file, this.state);
    if (!fs.existsSync(this.file + '.required')) fs.writeFileSync(this.file + '.required', 'required', { flag: 'wx', mode: 0o600 });
  }
  key(id, sub, name, kind, mediaId) { return `${id}:${sub.generation}:${name}:${kind}:${mediaId}`; }
  enqueue(key, task) {
    if (Object.hasOwn(this.state.seen, key)) return;
    const old = this.state.pending[key];
    this.state.pending[key] = { ...task, at: old?.at ?? Date.now(), eligibilityAt: old?.eligibilityAt ?? task.eligibilityAt, failures: old?.failures || 0, retryAt: old?.retryAt || 0 };
  }
  ingest(event) {
    const s = this.settings();
    if (event?.version !== 1 || !Number.isFinite(event.at)) throw Error('TELEGRAM_EVENT_INVALID');
    if (event.type === 'alert') {
      if (typeof event.text !== 'string' || event.text.length > 3500 || typeof event.id !== 'string') throw Error('TELEGRAM_ALERT_INVALID');
      if (event.kind === 'status') return; // Superseded by each user's daily preference.
      for (const id of alertRecipients(s, event)) this.enqueue(`alert:${event.id}:${id}`, { userId: id, type: 'alert', scope: event,
        method: 'sendMessage', body: { chat_id: id, text: event.text, link_preview_options: { is_disabled: true } } });
      this.persist(); return;
    }
    if (!validUsername(event.username) || !/^\d+$/.test(event.target || '')) throw Error('TELEGRAM_EVENT_TARGET_INVALID');
    const names = event.usernames?.length ? event.usernames : [event.username];
    if (!Array.isArray(names) || !names.every(validUsername)) throw Error('TELEGRAM_EVENT_TARGET_INVALID');
    if (event.type === 'stories') {
      if (!Array.isArray(event.stories)) throw Error('TELEGRAM_EVENT_STORIES_INVALID');
      for (const story of event.stories) {
        if (!/^\d+(?:_\d+)?$/.test(story.id) || !validMediaUrl(story.mediaUrl) || ![1, 2].includes(story.mediaType)) throw Error('TELEGRAM_EVENT_MEDIA_INVALID');
        const firstKey = `${event.target}:${story.id}`;
        this.state.firstSeen[firstKey] ??= event.at;
      }
      for (const id of s.allowedIds) for (const name of new Set(names)) {
        const sub = subscribed(s, id, name);
        if (!sub || event.at < sub.joinedAt) continue;
        const initKey = `${id}:${sub.generation}:${name}`;
        const initial = !this.state.initialized[initKey];
        const pref = sub.notifications.story;
        for (const story of event.stories) {
          if (!pref.enabled || (story.expiringAt && story.expiringAt * 1000 <= Date.now())) continue;
          const key = this.key(id, sub, name, 'story', story.id);
          if (!initial && !this.state.pending[key] && this.state.firstSeen[`${event.target}:${story.id}`] < pref.since) continue;
          if (event.at < pref.since) continue;
          const request = mediaRequest({ ...story, username: event.username }, id);
          this.enqueue(key, { userId: id, type: 'media', username: name, generation: sub.generation, kind: 'story',
            eligibilityAt: Math.max(this.state.firstSeen[`${event.target}:${story.id}`], initial ? sub.joinedAt : 0), ...request });
        }
        this.state.initialized[initKey] = true;
      }
    } else if (event.type === 'media') {
      if (!['post', 'highlight'].includes(event.kind) || typeof event.id !== 'string' || !['sendPhoto', 'sendVideo'].includes(event.method) ||
          !validMediaUrl(event.body?.photo || event.body?.video) || typeof event.body?.caption !== 'string' || !Number.isFinite(event.publishedAt)) throw Error('TELEGRAM_EVENT_MEDIA_INVALID');
      for (const id of s.allowedIds) for (const name of new Set(names)) {
        const sub = subscribed(s, id, name), pref = sub?.notifications[event.kind];
        if (!sub || !pref.enabled || event.at < Math.max(sub.joinedAt, pref.since) || event.publishedAt < sub.joinedAt) continue;
        const key = this.key(id, sub, name, event.kind, event.id);
        this.enqueue(key, { userId: id, type: 'media', username: name, generation: sub.generation, kind: event.kind,
          eligibilityAt: event.at, target: event.target, catalogKey: event.id,
          method: event.method, body: { ...event.body, chat_id: id } });
      }
    } else throw Error('TELEGRAM_EVENT_TYPE_INVALID');
    this.persist();
  }
  eligible(task) {
    const s = this.settings();
    if (!s.allowedIds.includes(task.userId)) return false;
    if (task.type === 'alert') return alertRecipients(s, task.scope).includes(task.userId);
    if (task.type === 'summary') return s.users[task.userId]?.daily === true && task.day === localDay(Date.now());
    const sub = subscribed(s, task.userId, task.username);
    return sub?.generation === task.generation && sub.notifications[task.kind]?.enabled && task.eligibilityAt >= sub.notifications[task.kind].since;
  }
  async drain(client, { limit = 20, stopping = () => false } = {}) {
    let count = 0, ok = true;
    for (const [key, task] of Object.entries(this.state.pending).sort(([,a],[,b]) => a.at - b.at)) {
      if (stopping() || count >= limit) break;
      if (!this.eligible(task)) { delete this.state.pending[key]; this.persist(); continue; }
      if (Date.now() < task.retryAt) { ok = false; continue; }
      if (!['sendMessage', 'sendPhoto', 'sendVideo'].includes(task.method) || String(task.body?.chat_id) !== task.userId) throw Error('TELEGRAM_PENDING_INVALID');
      // Refresh a queued catalog URL from the shared archive history, without re-sending
      // already acknowledged media or making another Instagram request.
      if (task.catalogKey && /^\d+$/.test(task.target)) {
        const catalog = load(path.join(this.stateDir, `catalog-${task.target}.json`), null);
        const url = catalog?.assets?.[task.catalogKey]?.mediaUrl;
        if (url && validMediaUrl(url)) task.body[task.method === 'sendVideo' ? 'video' : 'photo'] = url;
      }
      count++;
      try { await client.call(task.method, task.body); }
      catch (error) {
        task.failures++; task.retryAt = Date.now() + Math.min(300, 15 * 2 ** Math.min(task.failures, 5)) * 1000;
        task.error = /^TELEGRAM_[A-Z0-9_]+$/.test(error.message) ? error.message : 'TELEGRAM_SEND_FAILED';
        this.persist(); this.log('PERSONAL_DELIVERY_RETRY', { userId: task.userId, username: task.username, reason: task.error });
        ok = false; continue;
      }
      this.state.seen[key] = Date.now(); delete this.state.pending[key]; this.persist();
      this.log('PERSONAL_DELIVERY_SENT', { userId: task.userId, username: task.username, kind: task.kind || task.type });
    }
    return ok;
  }
  daily(now, describe) {
    const time = new Date(now + 8 * 3600000), day = localDay(now);
    if (time.getUTCHours() < 20) return;
    const s = this.settings();
    for (const id of s.allowedIds) {
      if (!s.users[id]?.daily || this.state.summaries[id] === day) continue;
      this.enqueue(`summary:${day}:${id}`, { userId: id, type: 'summary', day,
        method: 'sendMessage', body: { chat_id: id, text: `每日摘要（香港時間 20:00）\n${describe(id)}`, reply_markup: { inline_keyboard: [[{ text: '🔄 查看最新狀態', callback_data: 'status' }]] } } });
      this.state.summaries[id] = day;
    }
    this.persist();
  }
}
export const localDay = ms => new Date(ms + 8 * 3600000).toISOString().slice(0, 10);
