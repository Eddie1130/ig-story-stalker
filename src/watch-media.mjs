import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { save, fetchStories } from './watch-story.mjs';
import { mediaRequest, validMediaUrl, enqueue, deliver } from './story-media.mjs';

const log = (event, data = {}) => console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...data }));
async function main() {
  const target = process.env.IG_TARGET_USER_ID || '';
  const username = process.env.IG_TARGET_USERNAME || target;
  const token = process.env.TELEGRAM_BOT_TOKEN || '';
  const chatId = process.env.TELEGRAM_CHAT_ID || '';
  const interval = Number(process.env.IG_CHECK_INTERVAL_SECONDS || 300);
  if (!/^\d+$/.test(target) || !/^\d+:[A-Za-z0-9_-]+$/.test(token) || !chatId ||
      !Number.isInteger(interval) || interval < 60 || interval > 86400) throw Error('INVALID_CONFIG');
  const dir = '/app/state';
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `watch-media-${target}.json`);
  let state = { version: 2, target, sent: {}, pending: {}, failures: 0, alerted: false, telegramRetryAt: 0 };
  // RELIABILITY_STATE_SENTINEL_V1
  const required = file + '.required';
  if (fs.existsSync(required) && !fs.existsSync(file)) throw Error('MEDIA_HISTORY_FILE_MISSING');
  if (fs.existsSync(file)) {
    try { state = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch { throw Error('MEDIA_STATE_READ_OR_PARSE_FAILED'); }
    if (state.version !== 2 || state.target !== target || !state.sent || !state.pending ||
        Array.isArray(state.sent) || Array.isArray(state.pending) || typeof state.sent !== 'object' ||
        typeof state.pending !== 'object' || !Number.isInteger(state.failures) || state.failures < 0) throw Error('INVALID_MEDIA_STATE');
    for (const story of Object.values(state.pending)) if (!validMediaUrl(story.mediaUrl)) throw Error('INVALID_PENDING_MEDIA');
  }
  const markHistory = () => { if (!fs.existsSync(required)) fs.writeFileSync(required, 'history-required', { mode: 0o600, flag: 'wx' }); };
  if (fs.existsSync(file)) markHistory();
  const persist = () => { save(file, state); markHistory(); };
  let stopping = false, child = null, wake = () => {}, heartbeat;
  const aborter = new AbortController();
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
    stopping = true;
    aborter.abort();
    if (child) try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    wake();
  });
  let lastSendAt = 0;
  const callTelegram = async (method, body) => {
    if (Date.now() < (state.telegramRetryAt || 0)) throw Error('TELEGRAM_RETRY_WAIT');
    const wait = Math.max(0, 1100 - (Date.now() - lastSendAt));
    if (wait) await new Promise(resolve => setTimeout(resolve, wait));
    if (stopping) throw Error('TELEGRAM_STOPPING');
    lastSendAt = Date.now();
    let response, data;
    try {
      response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST', signal: AbortSignal.any([aborter.signal, AbortSignal.timeout(120000)]),
        headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      data = await response.json();
    } catch { throw Error('TELEGRAM_NETWORK_OR_RESPONSE_ERROR'); }
    if (!response.ok || data.ok !== true) {
      const retry = Number(data.parameters?.retry_after);
      if (Number.isFinite(retry) && retry > 0) { state.telegramRetryAt = Date.now() + retry * 1000; persist(); }
      // Do not log Telegram descriptions: they can repeat signed CDN URLs.
      throw Error(`TELEGRAM_ERROR_${data.error_code || response.status}`);
    }
    state.telegramRetryAt = 0;
  };
  // RELIABILITY_MEDIA_V1: supervisor/watchdog owns error messages in daemon mode.
  const sendText = text => process.env.IG_EXTERNAL_ERROR_MONITOR === '1' && !process.argv.includes('--test-telegram')
    ? Promise.resolve()
    : callTelegram('sendMessage', { chat_id: chatId, text, link_preview_options: { is_disabled: true } });
  const sendMedia = story => {
    const request = mediaRequest(story, chatId);
    return callTelegram(request.method, request.body);
  };
  if (process.argv.includes('--test-telegram')) {
    await sendText(`IG Story 媒體通知設定成功\n@${username}\n每 ${interval} 秒檢查；圖片／影片將直接傳送。`);
    log('TELEGRAM_TEST_OK'); return;
  }
  let nextFetchAt = 0, telegramOk = true;
  const health = () => save(path.join(dir, 'health.json'), {
    at: Date.now(), failures: state.failures, telegramOk, nextFetchAt,
  });
  heartbeat = setInterval(() => {
    try { health(); } catch { log('WATCH_FATAL', { reason: 'HEALTH_WRITE_FAILED' }); process.exit(1); }
  }, 30000);
  log('WATCH_MEDIA_STARTED', { target, intervalSeconds: interval, transport: 'telegram_url' });
  try {
    while (!stopping) {
      if (Date.now() >= nextFetchAt) {
        const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ig-media-'));
        const resultFile = path.join(temp, 'result.json');
        const previous = process.env.IG_STORY_RESULT_FILE;
        process.env.IG_STORY_RESULT_FILE = resultFile;
        try {
          const summary = await fetchStories('/app/src/fetch-story.mjs', c => { child = c; });
          if (stopping) break;
          const media = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
          if (String(summary.targetUserId) !== target || summary.guard?.blockedReadReceipt !== 0 ||
              !Array.isArray(summary.stories) || summary.storyCount !== summary.stories.length ||
              media.version !== 1 || media.targetUserId !== target || !Array.isArray(media.stories) ||
              media.storyCount !== media.stories.length) throw Error('UNTRUSTED_MEDIA_RESULT');
          const ids = new Set(summary.stories.map(s => s.id));
          for (const s of media.stories) {
            if (!ids.has(s.id) || !/^\d+(?:_\d+)?$/.test(s.id) || !validMediaUrl(s.mediaUrl) ||
                ![1, 2].includes(s.mediaType)) throw Error('UNTRUSTED_MEDIA_ITEM');
          }
          // Every fetched Story must be accounted for, including explicitly skipped media.
          if (!Array.isArray(media.skippedIds) || ids.size !== summary.storyCount) throw Error('UNTRUSTED_MEDIA_COVERAGE');
          const accounted = [...media.stories.map(s => s.id), ...media.skippedIds];
          if (new Set(accounted).size !== accounted.length || accounted.length !== ids.size ||
              accounted.some(id => !ids.has(id) || !/^\d+(?:_\d+)?$/.test(id))) throw Error('UNTRUSTED_MEDIA_COVERAGE');
          enqueue(state, media);
          state.failures = 0;
          state.lastSuccess = new Date().toISOString();
          log('WATCH_MEDIA_CHECK_OK', { storyCount: summary.storyCount, mediaCount: media.storyCount,
            skippedCount: media.skippedIds.length, skippedIds: media.skippedIds, mediaIds: media.stories.map(s => s.id), pendingCount: Object.keys(state.pending).length });
        } catch (error) {
          if (stopping) break;
          state.failures++;
          state.lastError = /^(FETCH_|STORY_|UNTRUSTED_)/.test(error.message) ? error.message : 'MEDIA_RESULT_READ_FAILED';
          log('WATCH_CHECK_FAILED', { consecutiveFailures: state.failures, reason: state.lastError });
        } finally {
          if (previous === undefined) delete process.env.IG_STORY_RESULT_FILE;
          else process.env.IG_STORY_RESULT_FILE = previous;
          fs.rmSync(temp, { recursive: true, force: true });
        }
        nextFetchAt = Date.now() + Math.min(interval * 2 ** Math.min(state.failures, 5), Math.max(interval, 1800)) * 1000;
        persist();
      }
      try {
        telegramOk = true;
        if (state.failures >= 3 && !state.alerted) {
          await sendText(`IG Story 檢查連續失敗 ${state.failures} 次：@${username}\n${state.lastError}\n稍後會重試。`);
          state.alerted = true; persist();
        } else if (state.failures === 0 && state.alerted) {
          await sendText(`IG Story 檢查已恢復：@${username}`);
          state.alerted = false; persist();
        }
        telegramOk = await deliver(state, sendMedia, persist,
          (id, mediaType) => log('STORY_MEDIA_SENT', { id, type: mediaType === 2 ? 'video' : 'photo' }),
          (id, reason) => log('STORY_MEDIA_RETRY', { id, reason }), () => stopping);
        // A permanently unavailable URL must not block newer Story deliveries.
        const failed = Object.values(state.pending).filter(s => s.deliveryFailures >= 3 && !s.failureNotified).slice(0, 5);
        for (const story of failed) {
          if (stopping) break;
          await sendText(`Story 媒體傳送失敗：@${username}\nStory ${story.id}\n${story.deliveryError}\n已保留待重試；其他 Story 會繼續傳送。`);
          story.failureNotified = true; persist();
        }
      } catch (error) {
        if (!error.message.startsWith('TELEGRAM_')) throw error;
        telegramOk = false;
        log('TELEGRAM_DELIVERY_FAILED', { reason: error.message, pendingCount: Object.keys(state.pending).length });
      }
      // Already-reported, unsent media remain available for inspection for 7 days.
      // Retire them to prevent an expired URL from being retried forever.
      for (const [id, story] of Object.entries(state.pending)) {
        if (story.failureNotified && Date.now() - story.detectedAt > 7 * 86400000) {
          state.failed ||= {};
          state.failed[id] = { at: Date.now(), reason: story.deliveryError };
          delete state.pending[id];
          log('STORY_MEDIA_RETIRED', { id });
        }
      }
      persist(); health();
      if (process.argv.includes('--once')) {
        process.exitCode = state.failures > 0 || !telegramOk ? 1 : 0;
        break;
      }
      const delay = Math.max(1000, Math.min(interval * 1000, nextFetchAt - Date.now()));
      log('WATCH_WAIT', { seconds: Math.ceil(delay / 1000), nextFetchAt: new Date(nextFetchAt).toISOString() });
      await new Promise(resolve => {
        const timer = setTimeout(resolve, delay);
        wake = () => { clearTimeout(timer); resolve(); };
        if (stopping) wake();
      });
    }
  } finally { clearInterval(heartbeat); }
  log('WATCH_STOPPED');
}
main().catch(error => { log('WATCH_FATAL', { reason: error.code || (/^[A-Z0-9_]+$/.test(error.message) ? error.message : 'UNEXPECTED_ERROR') }); process.exitCode = 1; });
