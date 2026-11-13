import { telegramApiBase } from './telegram-endpoint.mjs';
import path from 'node:path';
import { atomic, load } from './error-monitor.mjs';

export class TelegramClient {
  constructor({ token, dir, signal, fetchImpl = fetch, baseUrl = telegramApiBase(), sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
    if (!/^\d+:[A-Za-z0-9_-]+$/.test(token || '')) throw Error('INVALID_TELEGRAM_CONFIG');
    Object.assign(this, { token, signal, fetchImpl, sleep, baseUrl });
    this.file = path.join(dir, 'api-rate.json');
    this.rate = load(this.file, { retryAt: 0 });
    if (!Number.isFinite(this.rate.retryAt) || this.rate.retryAt < 0) throw Error('INVALID_TELEGRAM_RATE_STATE');
    this.chats = new Map(); this.nextAt = 0;
  }
  async call(method, body, { polling = false, files = [], timeoutMs, beforeRequest } = {}) {
    if (this.signal?.aborted) throw Error('TELEGRAM_STOPPING');
    if (Date.now() < this.rate.retryAt) throw Error('TELEGRAM_RETRY_WAIT');
    if (!polling) {
      const chat = String(body.chat_id || '');
      const at = Math.max(Date.now(), this.nextAt, this.chats.get(chat) || 0);
      this.nextAt = at + 40;
      if (chat) this.chats.set(chat, at + 1100);
      await this.sleep(at - Date.now());
      if (Date.now() < this.rate.retryAt) throw Error('TELEGRAM_RETRY_WAIT');
    }
    let payload = JSON.stringify(body), headers = { 'content-type': 'application/json' };
    if (files.length) {
      payload = new FormData(); headers = {};
      for (const [key, value] of Object.entries(body)) payload.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
      for (const file of files) payload.append(file.name, file.blob, file.filename);
    }
    if (this.signal?.aborted) throw Error('TELEGRAM_STOPPING');
    beforeRequest?.();
    let response, data;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/bot${this.token}/${method}`, {
        method: 'POST', headers, body: payload,
        signal: AbortSignal.any([...(this.signal ? [this.signal] : []), AbortSignal.timeout(timeoutMs || (polling ? 25000 : (files.length || /file:\/\//.test(JSON.stringify(body))) && this.baseUrl !== 'https://api.telegram.org' ? 3600000 : 20000))]),
      });
      data = await response.json();
    } catch { throw Error('TELEGRAM_NETWORK_OR_RESPONSE_ERROR'); }
    if (!response.ok || data.ok !== true) {
      const retry = Number(data.parameters?.retry_after);
      if (Number.isFinite(retry) && retry > 0) { this.rate.retryAt = Date.now() + retry * 1000; atomic(this.file, this.rate); }
      throw Error(`TELEGRAM_ERROR_${Number.isInteger(data.error_code) ? data.error_code : response.status}`);
    }
    return data.result;
  }
}
