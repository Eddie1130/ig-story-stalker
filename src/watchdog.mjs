import { formatJST } from './time-jst.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { atomic, load, queue, Issues, staleReason, safe, log } from './error-monitor.mjs';

const shared = process.env.IG_MONITOR_DIR || '/app/state/monitor';
const own = process.env.IG_WATCHDOG_DIR || '/app/watchdog-state';
const target = process.env.IG_TARGET_USERNAME || process.env.IG_TARGET_USER_ID || 'unknown';
if (process.argv.includes('--self-test')) {
  queue(path.join(own, 'outbox'), 'test', `IG 錯誤監控測試：@${target}\n警報已經過持久化佇列；收到這則訊息代表 watchdog 發送路徑正常。`);
  log('WATCHDOG_TEST_QUEUED');
} else {
  main().catch(error => { log('WATCHDOG_FATAL', { reason: safe(error.code || error.message || 'UNKNOWN') }); process.exitCode = 1; });
}
async function main() {
  const token = process.env.TELEGRAM_BOT_TOKEN || '';
  const chatId = process.env.TELEGRAM_CHAT_ID || '';
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(token) || !chatId) throw Error('INVALID_TELEGRAM_CONFIG');
  const ownOutbox = path.join(own, 'outbox');
  fs.mkdirSync(ownOutbox, { recursive: true });
  const store = path.join(own, 'delivery.json');
  const state = load(store, { retryAt: 0, deliveryFailed: false, lastSummaryAt: 0 });
  if (!state || typeof state !== 'object' || !Number.isFinite(state.retryAt) || typeof state.deliveryFailed !== 'boolean') throw Error('INVALID_WATCHDOG_STATE');
  const persist = () => atomic(store, state);
  const issues = new Issues(path.join(own, 'issues.json'), ownOutbox, '@' + target);
  let stopping = false, wake = () => {}, status = { at: Date.now(), telegramOk: !state.deliveryFailed };
  const abort = new AbortController();
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { stopping = true; abort.abort(); wake(); });
  const health = () => atomic(path.join(own, 'health.json'), { ...status, at: Date.now(), activeIssues: issues.activeCount() });
  health();
  const started = Date.now();
  log('WATCHDOG_STARTED');
  while (!stopping) {
    let sharedHealth;
    try {
      sharedHealth = load(path.join(shared, 'health.json'), null);
      const reason = staleReason(sharedHealth);
      if (reason && Date.now() - started > 120000) issues.fail('supervisor', reason);
      else if (!reason) issues.resolve('supervisor');
    } catch { issues.fail('supervisor', 'HEARTBEAT_READ_OR_PARSE_FAILED'); }
    if ((!staleReason(sharedHealth) || Date.now() - started > 120000) && Date.now() - (state.lastSummaryAt || 0) >= 86400000) {
      queue(ownOutbox, 'status', `IG watchdog 運行狀態：@${target}\n主程式：${staleReason(sharedHealth) || 'HEARTBEAT_OK'}\n最近成功檢查：${sharedHealth?.lastCheckAt ? formatJST(sharedHealth.lastCheckAt) : '尚未記錄'}\n主程式未解除異常：${sharedHealth?.activeIssues ?? '未知'}\nwatchdog 未解除異常：${issues.activeCount()}\n此訊息每日一次。`);
      state.lastSummaryAt = Date.now(); persist();
    }
    // Oldest queued alerts first, including incidents resolved while Telegram was down.
    const pending = [];
    let readError = false;
    for (const dir of [ownOutbox, path.join(shared, 'outbox')]) {
      try {
        for (const name of fs.readdirSync(dir)) if (name.endsWith('.json')) pending.push(path.join(dir, name));
      } catch (error) { if (error.code !== 'ENOENT') { readError = true; issues.fail('outbox-read', 'ALERT_OUTBOX_UNREADABLE'); } }
    }
    if (!readError) issues.resolve('outbox-read');
    pending.sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
    let attempts = 0, corruptSeen = false, scanned = 0;
    for (const file of pending) {
      if (attempts >= 5 || stopping || Date.now() < state.retryAt) break;
      scanned++;
      let alert;
      try {
        alert = load(file, null);
        if (!alert || typeof alert.text !== 'string' || alert.text.length > 3500) throw Error();
      } catch {
        corruptSeen = true;
        issues.fail('outbox-record', 'ALERT_RECORD_CORRUPT');
        // Keep the corrupt record on disk for inspection, without blocking other files.
        continue;
      }
      attempts++;
      try {
        const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST', signal: AbortSignal.any([abort.signal, AbortSignal.timeout(20000)]),
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text: alert.text, link_preview_options: { is_disabled: true } }),
        });
        const data = await r.json();
        if (!r.ok || data.ok !== true) {
          const seconds = Number(data.parameters?.retry_after);
          state.retryAt = Date.now() + (Number.isFinite(seconds) && seconds > 0 ? Math.max(30, seconds) : 60) * 1000;
          throw Error(`TELEGRAM_ERROR_${data.error_code || r.status}`);
        }
      } catch (error) {
        if (stopping) break;
        status.telegramOk = false;
        state.deliveryFailed = true;
        state.firstFailureAt ||= Date.now();
        state.retryAt = Math.max(state.retryAt, Date.now() + 30000);
        persist(); health();
        log('WATCHDOG_DELIVERY_RETRY', { reason: /^TELEGRAM_ERROR_\d+$/.test(error.message) ? error.message : 'NETWORK_OR_RESPONSE_ERROR', pendingCount: pending.length });
        break;
      }
      // Only remove the alert after Telegram confirms acceptance.
      fs.unlinkSync(file);
      log('WATCHDOG_ALERT_SENT', { kind: safe(alert.kind), id: safe(alert.id) });
      status.telegramOk = true;
      if (state.deliveryFailed) {
        queue(ownOutbox, 'recovery', `IG 警報傳送已恢復：@${target}\n先前自 ${formatJST(state.firstFailureAt)} 無法傳送警報；積存通知正在補發。`);
      }
      state.deliveryFailed = false; state.retryAt = 0; delete state.firstFailureAt; persist(); health();
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
    if (!corruptSeen && scanned === pending.length) issues.resolve('outbox-record');
    status.pendingCount = pending.length; health();
    if (process.argv.includes('--once')) { process.exitCode = status.telegramOk ? 0 : 1; break; }
    await new Promise(resolve => { const timer = setTimeout(resolve, 30000); wake = () => { clearTimeout(timer); resolve(); }; if (stopping) wake(); });
  }
  log('WATCHDOG_STOPPED');
}
