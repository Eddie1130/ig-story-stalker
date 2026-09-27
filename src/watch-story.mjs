import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const log = (event, data = {}) => console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...data }));
export function save(file, state) {
  fs.writeFileSync(file + '.tmp', JSON.stringify(state), { mode: 0o600 });
  fs.renameSync(file + '.tmp', file);
}
export function ingest(state, result, target, now = Date.now()) {
  if (String(result?.targetUserId) !== target || !Array.isArray(result?.stories) ||
      result.storyCount !== result.stories.length || result.guard?.blockedReadReceipt !== 0) {
    throw new Error('UNTRUSTED_FETCH_RESULT');
  }
  for (const story of result.stories) {
    if (!/^\d+(?:_\d+)?$/.test(story.id)) throw new Error('INVALID_STORY_ID');
  }
  for (const story of result.stories) {
    if (Number.isFinite(story.expiringAt) && story.expiringAt * 1000 <= now) continue;
    if (!Object.hasOwn(state.sent, story.id) && !Object.hasOwn(state.pending, story.id)) {
      state.pending[story.id] = { ...story, detectedAt: now };
    }
  }
  // Retain sent IDs for 30 days; pending notifications survive Story expiry.
  for (const [id, at] of Object.entries(state.sent)) if (now - at > 30 * 86400000) delete state.sent[id];
}
export async function drain(state, send, persist, describe, onSent = () => {}) {
  for (const story of Object.values(state.pending).slice(0, 20)) {
    await send(describe(story));
    state.sent[story.id] = Date.now();
    delete state.pending[story.id];
    persist();
    onSent(story.id);
  }
}
export function fetchStories(script, onChild = () => {}, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    onChild(child);
    let result, event = 'FETCH_FAILED', expired = false;
    const timer = setTimeout(() => {
      expired = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    }, timeoutMs);
    const reader = readline.createInterface({ input: child.stdout });
    reader.on('line', line => {
      try {
        const row = JSON.parse(line);
        if (row.event === 'STORY_FETCH_SUCCESS') result = row;
        // RELIABILITY_FETCH_EVENTS_V1
        else if (/ERROR|INVALID|FATAL|FAILURE|FALLBACK/.test(row.event || '')) {
          event = [row.event, Number.isFinite(row.status) ? 'http=' + row.status : '',
            Number.isFinite(row.errorCode) ? 'code=' + row.errorCode : ''].filter(Boolean).join(':');
        }
      } catch {}
    });
    // The original fetcher writes audit.log. Do not repeat potentially sensitive stderr.
    child.stderr.resume();
    child.on('error', () => { clearTimeout(timer); reject(new Error('FETCH_PROCESS_START_FAILED')); });
    child.on('close', code => {
      clearTimeout(timer);
      onChild(null);
      if (expired) reject(new Error('FETCH_TIMEOUT'));
      else if (code !== 0 || !result) reject(new Error(`${event}:exit=${code}`));
      else resolve(result);
    });
  });
}

async function main() {
  const target = process.env.IG_TARGET_USER_ID || '';
  const username = process.env.IG_TARGET_USERNAME || target;
  const token = process.env.TELEGRAM_BOT_TOKEN || '';
  const chatId = process.env.TELEGRAM_CHAT_ID || '';
  const interval = Number(process.env.IG_CHECK_INTERVAL_SECONDS || 300);
  if (!/^\d+$/.test(target) || !/^\d+:[A-Za-z0-9_-]+$/.test(token) || !chatId ||
      !Number.isInteger(interval) || interval < 60 || interval > 86400) throw new Error('INVALID_CONFIG');
  const dir = '/app/state';
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `watch-${target}.json`);
  let state = { version: 1, target, sent: {}, pending: {}, failures: 0, alerted: false, telegramRetryAt: 0 };
  if (fs.existsSync(file)) {
    state = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (state.version !== 1 || state.target !== target || !state.sent || !state.pending ||
        Array.isArray(state.sent) || Array.isArray(state.pending) ||
        typeof state.sent !== 'object' || typeof state.pending !== 'object' ||
        !Number.isInteger(state.failures) || state.failures < 0) throw new Error('INVALID_STATE_FILE');
  }
  const persist = () => save(file, state);
  let stopping = false, child = null, wake = () => {};
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
    stopping = true;
    if (child) try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    wake();
  });
  let lastSendAt = 0;
  const send = async text => {
    if (Date.now() < (state.telegramRetryAt || 0)) throw new Error('TELEGRAM_RETRY_WAIT');
    const wait = Math.max(0, 1100 - (Date.now() - lastSendAt));
    if (wait) await new Promise(resolve => setTimeout(resolve, wait));
    lastSendAt = Date.now();
    let response, data;
    try {
      response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST', signal: AbortSignal.timeout(20000),
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, link_preview_options: { is_disabled: true } }),
      });
      data = await response.json();
    } catch { throw new Error('TELEGRAM_NETWORK_OR_RESPONSE_ERROR'); }
    if (!response.ok || data.ok !== true) {
      const retry = Number(data.parameters?.retry_after);
      if (Number.isFinite(retry) && retry > 0) {
        state.telegramRetryAt = Date.now() + retry * 1000;
        persist();
      }
      throw new Error(`TELEGRAM_ERROR_${data.error_code || response.status}`);
    }
    state.telegramRetryAt = 0;
  };
  if (process.argv.includes('--test-telegram')) {
    await send(`IG Story 通知測試成功\n目標：@${username}\n檢查間隔：${interval} 秒`);
    log('TELEGRAM_TEST_OK');
    return;
  }
  const formatTime = seconds => Number.isFinite(seconds)
    ? new Date(seconds * 1000).toLocaleString('zh-HK', { timeZone: 'Asia/Hong_Kong', hour12: false }) : '未知';
  const describe = story => [
    `Instagram 新偵測到 Story：@${username}`,
    `類型：${story.mediaType === 2 ? '影片' : story.mediaType === 1 ? '圖片' : '其他'}`,
    `發布：${formatTime(story.takenAt)}（香港時間）`,
    `到期：${formatTime(story.expiringAt)}（香港時間）`,
    `Story ID：${story.id}`,
    '已取得資料；未下載媒體。',
  ].join('\n');
  log('WATCH_STARTED', { target, intervalSeconds: interval });
  let nextFetchAt = 0;
  while (!stopping) {
    let telegramOk = true;
    if (Date.now() >= nextFetchAt) {
      try {
        const result = await fetchStories('/app/src/fetch-story.mjs', value => { child = value; });
        if (stopping) break;
        ingest(state, result, target);
        state.failures = 0;
        state.lastSuccess = new Date().toISOString();
        log('WATCH_CHECK_OK', { storyCount: result.storyCount, pendingCount: Object.keys(state.pending).length });
      } catch (error) {
        if (stopping) break;
        state.failures++;
        state.lastError = error.message;
        log('WATCH_CHECK_FAILED', { consecutiveFailures: state.failures, reason: error.message });
      }
      nextFetchAt = Date.now() + Math.min(interval * 2 ** Math.min(state.failures, 5), Math.max(interval, 1800)) * 1000;
      persist();
    }
    try {
      if (state.failures >= 3 && !state.alerted) {
        await send(`IG Story 檢查連續失敗 ${state.failures} 次：@${username}\n${state.lastError}\n系統會延長間隔後重試，請檢查容器日誌。`);
        state.alerted = true;
        persist();
      } else if (state.failures === 0 && state.alerted) {
        await send(`IG Story 檢查已恢復：@${username}`);
        state.alerted = false;
        persist();
      }
      await drain(state, send, persist, describe, id => log('STORY_NOTIFIED', { id }));
    } catch (error) {
      // State writes must fail closed: continuing could lose deduplication records.
      if (!error.message.startsWith('TELEGRAM_')) throw error;
      telegramOk = false;
      log('TELEGRAM_DELIVERY_FAILED', { reason: error.message, pendingCount: Object.keys(state.pending).length });
    }
    save(path.join(dir, 'health.json'), { at: Date.now(), failures: state.failures, telegramOk, nextFetchAt });
    const delay = Math.max(1000, Math.min(interval * 1000, nextFetchAt - Date.now()));
    log('WATCH_WAIT', { seconds: Math.ceil(delay / 1000), nextFetchAt: new Date(nextFetchAt).toISOString() });
    await new Promise(resolve => {
      const timer = setTimeout(resolve, delay);
      wake = () => { clearTimeout(timer); resolve(); };
      if (stopping) wake();
    });
  }
  log('WATCH_STOPPED');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { log('WATCH_FATAL', { reason: error.message }); process.exitCode = 1; });
}
