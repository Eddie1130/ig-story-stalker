import fs from 'node:fs';
import path from 'node:path';
import { atomic, load } from './error-monitor.mjs';
import { validManualFile } from './manual-files.mjs';
import { jobFile } from './manual-jobs.mjs';
import { videoAttributes, videoPreview } from './video-attributes.mjs';

export const CLOUD_FILE_LIMIT = 50_000_000;
export function albumPlan(files) {
  const groups = [], oversized = [];
  let current = [];
  const flush = () => { if (current.length) groups.push(current); current = []; };
  for (const file of files) {
    if (file.bytes > CLOUD_FILE_LIMIT) { flush(); oversized.push(file); continue; }
    const ratio = file.width && file.height ? Math.max(file.width/file.height,file.height/file.width) : 1;
    const type = file.mediaType === 2 ? 'video' : file.bytes > 10_000_000 || Number(file.width || 0)+Number(file.height || 0)>10000 || ratio>20 ? 'document' : 'photo';
    if (current.length && ((current[0].type === 'document') !== (type === 'document'))) flush();
    current.push({ ...file, type });
    if (current.length === 10) flush();
  }
  flush(); return { groups, oversized };
}
export class ManualDelivery {
  constructor({ root, dir, stateDir, settings, log = () => {}, probe = videoAttributes, preview = videoPreview, fileResolver = validManualFile }) {
    Object.assign(this, { root, dir, stateDir, settings, log, probe, preview, fileResolver });
    this.file = path.join(dir, 'manual-delivery.json');
    if (fs.existsSync(this.file + '.required') && !fs.existsSync(this.file)) throw Error('MANUAL_DELIVERY_HISTORY_MISSING');
    this.state = load(this.file, { version: 1, jobs: {} });
    if (this.state?.version !== 1 || !this.state.jobs || typeof this.state.jobs !== 'object' || Array.isArray(this.state.jobs)) throw Error('MANUAL_DELIVERY_HISTORY_INVALID');
    for (const entry of Object.values(this.state.jobs)) if (entry.inflight) { entry.uncertain = true; delete entry.inflight; }
    this.persist();
  }
  persist() {
    atomic(this.file, this.state);
    if (!fs.existsSync(this.file + '.required')) fs.writeFileSync(this.file + '.required', 'required', { flag: 'wx', mode: 0o600 });
  }
  async drain(client, { stopping = () => false } = {}) {
    let ok = true;
    for (const request of Object.values(this.settings().manualRequests || {}).sort((a,b) => a.at-b.at)) {
      if (stopping()) break;
      if (!this.settings().allowedIds.includes(request.userId)) continue;
      let job;
      try { job = load(jobFile(this.stateDir, request.id), null); }
      catch { job = { version: 1, id: request.id, status: 'failed', reason: 'MANUAL_JOB_HISTORY_INVALID', userId: request.userId, url: request.url }; }
      if ((fs.existsSync(jobFile(this.stateDir, request.id)) && !job) || (job && (job.version !== 1 || job.id !== request.id || job.userId !== request.userId || job.url !== request.url || !['queued','working','retry','ready','failed'].includes(job.status)))) {
        job = { status: 'failed', reason: 'MANUAL_JOB_HISTORY_INVALID', userId: request.userId, url: request.url };
      }
      if (!job || !['ready','failed'].includes(job.status)) continue;
      const entry = this.state.jobs[request.id] ||= { next: 0, failures: 0 };
      if (entry.done || Date.now() < (entry.retryAt || 0)) continue;
      if (job.status === 'ready' && (!job.result || !Array.isArray(job.result.files) || !job.result.files.length ||
          typeof job.result.username !== 'string' || !/^[a-z0-9_.]{1,30}$/.test(job.result.username) || typeof job.result.caption !== 'string' ||
          job.result.files.some(f => !f || !Number.isSafeInteger(f.bytes) || f.bytes < 12 || ![1,2].includes(f.mediaType) || typeof f.relativePath !== 'string'))) {
        job = { status: 'failed', reason: 'MANUAL_JOB_HISTORY_INVALID', userId: request.userId, url: request.url };
      }
      const result = job.status === 'ready' ? job.result : null;
      const plan = result ? albumPlan(result.files) : { groups: [], oversized: [] };
      if (job.status === 'ready' && !entry.uncertain) {
        while (entry.next < plan.groups.length && !entry.localError && !stopping()) {
          if (!this.settings().allowedIds.includes(request.userId)) break;
          const group = plan.groups[entry.next];
          let upload;
          try {
            upload = await this.upload(group, result, request.userId, entry.documents === entry.next);
          } catch (error) {
            entry.localError = /^MANUAL_[A-Z0-9_]+$/.test(error.message) ? error.message : 'MANUAL_LOCAL_FILE_UNAVAILABLE'; this.persist(); break;
          }
          try {
            const response = await client.call(upload.method, upload.body, { files: upload.files, timeoutMs: 180000,
              beforeRequest: () => { entry.inflight = { group: entry.next, at: Date.now() }; this.persist(); } });
            const receipts = Array.isArray(response) ? response : [response];
            if (receipts.length !== group.length || receipts.some(r => !Number.isSafeInteger(r?.message_id))) throw Error('MANUAL_DELIVERY_UNCERTAIN');
            entry.messageIds ||= []; entry.messageIds.push(...receipts.map(r => r.message_id));
            delete entry.inflight; entry.next++; entry.failures = 0; delete entry.documents; this.persist();
          } catch (error) {
            if (error.code || !/^(TELEGRAM_|MANUAL_DELIVERY_UNCERTAIN)/.test(error.message)) throw error;
            const notSent = /^(TELEGRAM_RETRY_WAIT|TELEGRAM_STOPPING|TELEGRAM_ERROR_(400|401|403|429))$/.test(error.message);
            if (notSent) {
              delete entry.inflight;
              if (error.message === 'TELEGRAM_ERROR_400' && entry.documents !== entry.next && group.some(f => f.type !== 'document')) { entry.documents = entry.next; this.persist(); continue; }
              entry.failures++;
              entry.retryAt = Math.max(client.rate?.retryAt || 0, Date.now() + 30000);
              if (entry.failures >= 3 && !/RETRY_WAIT|STOPPING|429/.test(error.message)) entry.localError = error.message;
              this.persist(); ok = false; break;
            }
            entry.uncertain = true; delete entry.inflight; this.persist(); break;
          }
        }
        if (stopping()) break;
        if (entry.next < plan.groups.length && !entry.localError && !entry.uncertain) continue;
      }
      let text;
      if (entry.uncertain) text = `Telegram 傳送結果不明，已保留本機原檔，沒有自動重送。請先確認收到的內容，需要時可重新貼上連結。\n${request.url}`;
      else if (entry.localError) text = `媒體未能完整傳送：${entry.localError}\n已保留本機檔案。\n${request.url}`;
      else if (job.status === 'failed') text = `下載失敗：${manualFailureText(job.reason || 'MANUAL_DOWNLOAD_FAILED')}\n${request.url}`;
      else if (plan.oversized.length || result.errors?.length) text = [
        plan.oversized.length ? `${plan.oversized.length} 個檔案過大，已下載但無法直接傳送。` : '',
        result.errors?.length ? `${result.errors.length} 個媒體未能下載；其他可取得內容已回傳。\n${[...new Set(result.errors.map(e => manualFailureText(e.reason)))].slice(0,3).join('；')}` : '',
        `本機位置：downloads/instagram/manual/${result.username}/${result.kind}/${result.contentId}/`, request.url,
      ].filter(Boolean).join('\n');
      if (text) {
        try { await client.call('sendMessage', { chat_id: request.userId, text, link_preview_options: { is_disabled: true } }); }
        catch (error) { if (!error.message.startsWith('TELEGRAM_')) throw error; entry.retryAt = Date.now()+30000; this.persist(); ok = false; continue; }
      }
      entry.done = true; this.persist(); this.log('MANUAL_DELIVERY_STATUS', { jobId: request.id, status: entry.uncertain ? 'uncertain' : entry.localError || job.status === 'failed' ? 'failed' : 'complete' });
    }
    return ok;
  }
  async upload(group, result, userId, documents) {
    const files = [], media = [];
    const filenames = group.map(file => this.fileResolver(this.root, file));
    const attributes = [], previews = [];
    if (!documents) {
      for (let i = 0; i < group.length; i++) {
        if (group[i].type !== 'video') continue;
        attributes[i] = await this.probe(filenames[i]);
        if (attributes[i]) previews[i] = await this.preview(filenames[i], attributes[i]);
        if (!attributes[i] || !previews[i]) documents = true;
      }
    }
    // Keep original group boundaries so persisted delivery receipts stay valid.
    // Telegram forbids mixing documents with photos/videos in the same album.
    for (let i = 0; i < group.length; i++) {
      const file = group[i], filename = filenames[i], name = 'media' + i;
      const type = documents ? 'document' : file.type;
      const blob = await fs.openAsBlob(filename, { type: path.extname(filename) === '.mp4' ? 'video/mp4' : path.extname(filename) === '.png' ? 'image/png' : path.extname(filename) === '.webp' ? 'image/webp' : 'image/jpeg' });
      files.push({ name, blob, filename: path.basename(filename) });
      if (type === 'video') {
        const blob = new Blob([previews[i]], { type: 'image/jpeg' });
        files.push({ name: 'thumb' + i, blob, filename: 'thumbnail.jpg' });
        files.push({ name: 'cover' + i, blob, filename: 'cover.jpg' });
      }
      media.push({ type, media: 'attach://' + name, ...(type === 'video' ? { supports_streaming: true, ...attributes[i], thumbnail: 'attach://thumb' + i, cover: 'attach://cover' + i } : {}),
        ...(i === 0 ? { caption: [`@${result.username}`, result.url, result.caption].filter(Boolean).join('\n').slice(0,900) } : {}) });
    }
    if (media.length > 1) return { method: 'sendMediaGroup', body: { chat_id: userId, media }, files };
    const item = media[0], method = { photo: 'sendPhoto', video: 'sendVideo', document: 'sendDocument' }[item.type];
    return { method, body: { chat_id: userId, [item.type]: item.media, caption: item.caption, ...(item.type === 'video' ? { supports_streaming: true, width: item.width, height: item.height, thumbnail: item.thumbnail, cover: item.cover, ...(item.duration !== undefined ? { duration: item.duration } : {}) } : {}) }, files };
  }
}

export function manualFailureText(reason) {
  if (/STORY_UNAVAILABLE/.test(reason)) return '該則 Story 已過期、已刪除，或目前登入帳號無法存取。';
  if (/SESSION_INVALID/.test(reason)) return 'Instagram 登入已失效，請重新建立登入。';
  if (/HTTP_404|MEDIA_UNAVAILABLE/.test(reason)) return '內容不存在、已刪除，或目前登入帳號無法存取。';
  if (/SHARE_UNRESOLVED/.test(reason)) return '無法解析分享短連結，請改貼原始貼文、Reel 或 Story 網址。';
  if (/HISTORY|CACHE_INVALID|FILE_INCOMPLETE/.test(reason)) return '本機紀錄或檔案不完整，原有資料已保留，請檢查日誌。';
  if (/NETWORK|TIMEOUT|HTTP_5/.test(reason)) return '網路或 Instagram 回應暫時異常，重試後仍未成功。';
  return /^[A-Z0-9_]+$/.test(reason || '') ? reason : '無法完成下載，請稍後重試。';
}
