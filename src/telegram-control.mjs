import { telegramApiBase } from './telegram-endpoint.mjs';
import { TikTokDelivery } from './tiktok-delivery.mjs';
import { ManualDelivery } from './manual-delivery.mjs';
import { flushReplies } from './telegram-replies.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { atomic, load, log } from './error-monitor.mjs';
import { settingsFile, initializeSettings, isSystemAlert, serviceUnavailableText } from './telegram-settings.mjs';
import { eventDirectory } from './telegram-events.mjs';
import { applyUpdate } from './telegram-menu.mjs';
import { PersonalDelivery } from './telegram-delivery.mjs';
import { TelegramClient } from './telegram-client.mjs';
import { XDelivery } from './x-delivery.mjs';
import { formatXHistory, compactXHistory } from './x-status.mjs';
import { ingestExportReports, exportServiceReady, exportAccountNames } from './archive-export.mjs';

export function describeUser(settings, id, stateDir, watchdogDir = null) {
  let readErrors = 0;
  const read = (file, fallback) => { try { return load(file, fallback); } catch { readErrors++; return fallback; } };
  const user = settings.users[id], health = read(path.join(stateDir, 'health.json'), null);
  const targets = Array.isArray(health?.targets) ? health.targets : [];
  const names = Object.keys(user?.targets || {});
  const lines = ['📊 你的監看狀態', `每日摘要：${user?.daily ? '開啟' : '關閉'}（異常與恢復通知保持開啟）`];
  lines.push('', '📷 Instagram', `監看帳號：${names.length}`);
  if (!names.length) lines.push('尚未加入 Instagram 監看帳號。');
  for (const name of names) {
    const target = targets.find(t => t?.username === name);
    const catalog = target?.target && /^\d+$/.test(target.target) ? read(path.join(stateDir, `catalog-${target.target}.json`), null) : null;
    const assets = Object.values(catalog?.assets || {});
    const pending = assets.filter(a => !a?.archiveDone).length;
    lines.push(`@${name}：${!target ? '等待解析帳號' : target.failures >= 3 ? '檢查異常／重試中' : target.failures ? `等待重試（${target.failures}/3）` : '監看中'}；貼文／精選已下載 ${assets.length - pending}，待下載 ${pending}`);
  }
  const xNames = Object.keys(user?.xTargets || {});
  if (xNames.length) {
    const xHealth = read(path.join(stateDir, 'x/health.json'), null);
    const xTargets = Array.isArray(xHealth?.targets) ? xHealth.targets : [];
    lines.push('', '𝕏 X', `監看帳號：${xNames.length}`);
    for (const name of xNames) {
      const target = xTargets.find(target => target?.username === name);
      lines.push(`X @${name}：${xHealth?.enabled === false ? '已停用' : !target ? '等待首次檢查' : target.failures ? '檢查異常／重試中' : '監看中'}${Number.isSafeInteger(target?.saved) ? `；已封存 ${target.saved}` : ''}${Number.isSafeInteger(target?.pending) ? `，待下載 ${target.pending}` : ''}`);
    }
    if (!xHealth || !Number.isFinite(xHealth.at) || Date.now() - xHealth.at > 120000) lines.push('X worker 心跳尚未建立或已過期。');
    const shared = Array.isArray(xHealth?.historyJobs) ? xHealth.historyJobs.filter(job => job && xNames.includes(job.username)) : [];
    const requests = Object.values(settings.xRequests || {}).filter(request => request.userId === id && request.type === 'history' &&
      xNames.includes(request.username) && /^\d{1,20}-\d{1,16}-\d{1,2}$/.test(request.id)).sort((a, b) => b.at - a.at).slice(0, 20);
    const reportCandidates = requests.map(request => {
      const saved = read(path.join(stateDir, 'x/jobs', request.id + '.json'), null);
      if (saved && typeof saved === 'object' && !Array.isArray(saved) && (!saved.username || saved.username === request.username)) return { ...saved, username: request.username };
      const active = shared.find(job => job.username === request.username && (!request.start || request.start === job.start) && (!request.end || request.end === job.end));
      return active || { username: request.username, status: 'queued', requestedAt: request.at, start: request.start, end: request.end };
    });
    const reportsById = new Map();
    for (const job of [...reportCandidates, ...shared]) {
      const identity = typeof job.id === 'string' && job.id.length <= 128 ? job.id :
        `${typeof job.start === 'string' && job.start.length <= 10 ? job.start : ''}:${typeof job.end === 'string' && job.end.length <= 10 ? job.end : ''}`;
      const key = `${job.username}:${identity}`, old = reportsById.get(key);
      if (!old || (Number.isFinite(job.at) ? job.at : 0) > (Number.isFinite(old.at) ? old.at : 0)) reportsById.set(key, job);
    }
    const reports = [...reportsById.values()].filter(job => ['queued', 'working', 'running', 'importing', 'retry'].includes(job.status) || (['complete', 'ready', 'partial'].includes(job.status) && job.reported !== true && ['archive', 'rendering'].includes(job.phase)));
    if (reports.length) {
      lines.push('', '歷史回補');
    const locked = Number.isSafeInteger(xHealth?.pool?.locked) && xHealth.pool.locked >= 0 ? xHealth.pool.locked : 0;
    if (Number.isSafeInteger(xHealth?.pool?.active)) lines.push(`X 回補帳號池：可用 ${Math.max(0, xHealth.pool.active - locked)}，限流等待 ${locked}`);
    else lines.push('X 回補帳號池狀態尚未取得。');
    }
    const priority = job => ['working', 'running', 'importing'].includes(job.status) || ['archive', 'rendering'].includes(job.phase) ? 0 : job.status === 'retry' ? 1 : job.status === 'queued' ? 2 : 3;
    const requestedAt = job => Number.isFinite(job.requestedAt) ? job.requestedAt : Number.isFinite(job.at) ? job.at : 0;
    reports.sort((a, b) => priority(a) - priority(b) || requestedAt(b) - requestedAt(a));
    for (const [index, job] of reports.slice(0, 5).entries()) lines.push(index < 2 ? formatXHistory(job) : compactXHistory(job));
  }
  const ttNames = Object.keys(user?.tiktokTargets || {});
  if (ttNames.length) {
    const h = read(path.join(stateDir, "tiktok/health.json"), null);
    lines.push("", "🎬 TikTok LIVE");
    for (const name of ttNames) lines.push(`@${name}：${h?.targets?.[name]?.phase || "等待首次檢查"}`);
    if (!h || Date.now() - h.at > 120000) lines.push("TikTok worker 心跳過期或尚未啟動。");
    const catalog = read(path.join(stateDir, 'tiktok/catalog/health.json'), null);
    if (!catalog || Date.now() - catalog.at > 120000 || catalog.phase === 'stopped') lines.push('TikTok 內容監控尚未啟動或心跳過期。');
    else {
      for (const name of ttNames) for (const [kind, state] of Object.entries(catalog.targets?.[name] || {})) lines.push(`@${name} ${kind}：${state.phase}${state.reason ? '（' + state.reason + '）' : ''}`);
      lines.push(`內容待下載：${catalog.pending || 0}`);
    }
  }
  const issues = { ...read(path.join(stateDir, 'monitor/issues.json'), {}), ...(watchdogDir ? read(path.join(watchdogDir, 'issues.json'), {}) : {}) };
  const targetIds = new Set(targets.filter(t => t && names.includes(t.username)).map(t => t.target));
  const relevant = Object.entries(issues).filter(([key, v]) => v?.active && (!key.startsWith('target:') || targetIds.has(v.target) || v.usernames?.some(name => names.includes(name)) || names.some(name => key.startsWith(`target:${name}:`))));
  const visibleIssues = relevant.slice(0, 6).map(([key, v]) => id !== settings.ownerId && isSystemAlert({ ...v, issueKey: key, username: /^target:([^:]+):/.exec(key)?.[1] }) ? serviceUnavailableText : `${key}：${v.reason}`);
  lines.push('', '🔎 系統狀態', `目前異常：${relevant.length}`, ...new Set(visibleIssues));
  if (readErrors) lines.push(id === settings.ownerId ? `有 ${readErrors} 份執行狀態讀取失敗，請檢查監控日誌。` : serviceUnavailableText);
  if (health && (!Number.isFinite(health.at) || Date.now() - health.at > 120000)) lines.push('監看程序心跳已過期，顯示的是先前紀錄。');
  lines.push(`查詢時間：${new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Hong_Kong', dateStyle: 'short', timeStyle: 'medium', hour12: false }).format(new Date())}（香港）`);
  return lines.join('\n').slice(0, 3400);
}

// Refresh pre-upgrade status snapshots before retrying persisted messages.
export function refreshQueuedDescriptions(delivery, settings, describe) {
  for (const task of Object.values(delivery.state.pending)) {
    if (task.type === 'summary') task.body.text = `每日摘要（香港時間 20:00）\n${describe(task.userId)}`;
  }
  for (const reply of Object.values(settings.replies)) {
    if (reply.method === 'sendMessage' && reply.body?.text?.startsWith('📊 你的監看狀態')) reply.body.text = describe(reply.userId);
  }
}

export async function run({ env = process.env, args = process.argv } = {}) {
  const dir = env.IG_CONTROL_DIR || '/app/control', stateDir = env.IG_STATE_DIR || '/app/state';
  if (env.IG_TELEGRAM_CONTROL === '0') {
    const health = () => atomic(path.join(dir, 'health.json'), { at: Date.now(), enabled: false, telegramOk: true, pollOk: true, lastPollAt: Date.now() });
    health();
    if (args.includes('--once')) return;
    await new Promise(resolve => {
      const tick = setInterval(health, 15000);
      const stop = () => { clearInterval(tick); for (const name of ['SIGTERM', 'SIGINT']) process.off(name, stop); resolve(); };
      for (const name of ['SIGTERM', 'SIGINT']) process.on(name, stop);
    });
    return;
  }
  let settings = initializeSettings(env);
  const signal = new AbortController();
  let stopping = false, telegramOk = true, xTelegramOk = true, pollOk = true, lastPollAt = Date.now();
  const stop = () => { stopping = true; signal.abort(); };
  for (const name of ['SIGTERM', 'SIGINT']) process.on(name, stop);
  const wait = ms => new Promise(resolve => { const t = setTimeout(done, ms); function done() { clearTimeout(t); signal.signal.removeEventListener('abort', done); resolve(); } signal.signal.addEventListener('abort', done, { once: true }); if (stopping) done(); });
  const client = new TelegramClient({ token: env.TELEGRAM_BOT_TOKEN, baseUrl: telegramApiBase(env), dir, signal: signal.signal, sleep: wait });
  const delivery = new PersonalDelivery({ dir, stateDir, settings: () => settings, log });
  const manual = new ManualDelivery({ root: env.IG_ARCHIVE_DIR || '/downloads', dir, stateDir, settings: () => settings, log });
  const xDelivery = env.X_ENABLED === '0' ? null : new XDelivery({ root: env.IG_ARCHIVE_DIR || '/downloads', dir, stateDir, settings: () => settings, log });
  const ttDelivery = new TikTokDelivery({ root: env.IG_ARCHIVE_DIR || "/downloads", dir, stateDir, settings: () => settings, log });
  const ttOk = { video: true, notice: true, content: true, story: true };
  const persistSettings = () => atomic(settingsFile(env), settings);
  const describe = id => describeUser(settings, id, stateDir, env.IG_WATCHDOG_DIR || '/app/watchdog-state');
  refreshQueuedDescriptions(delivery, settings, describe);
  delivery.persist(); persistSettings();
  const health = () => atomic(path.join(dir, 'health.json'), { at: Date.now(), telegramOk: telegramOk && xTelegramOk && ttOk.video && ttOk.notice && ttOk.content && ttOk.story, pollOk, lastPollAt, pending: Object.keys(delivery.state.pending).length });
  const heartbeat = setInterval(health, 15000);
  try {
    // Do not silently delete another deployment's webhook or pending updates.
    const webhook = await client.call('getWebhookInfo', {}, { polling: true });
    if (webhook?.url) throw Error('TELEGRAM_WEBHOOK_CONFIGURED');
    await client.call('setMyCommands', { commands: [{ command: 'menu', description: '開啟 Instagram／X 設定選單' }, { command: 'status', description: '查看我的監看狀態' }, { command: 'add', description: '新增 IG 帳號，例如 /add alice' }, { command: 'ttadd', description: '新增 TikTok 帳號，例如 /ttadd alice' }, { command: 'xadd', description: '新增 X 帳號，例如 /xadd alice' }, { command: 'xhistory', description: '歷史回補，例如 /xhistory alice' }, { command: 'cancel', description: '取消目前操作' }, { command: 'download', description: '貼上 Instagram、X 或 TikTok 連結下載原檔' }] });
    await client.call('setChatMenuButton', { menu_button: { type: 'commands' } });
    health(); log('TELEGRAM_CONTROL_STARTED');
    async function poll() {
      do {
        try {
          const updates = await client.call('getUpdates', { offset: settings.offset, timeout: args.includes('--once') ? 0 : 10, allowed_updates: ['message', 'callback_query'], limit: 50 }, { polling: true });
          if (!Array.isArray(updates)) throw Error('TELEGRAM_UPDATES_INVALID');
          for (const update of updates) {
            const candidate = structuredClone(settings);
            if (applyUpdate(candidate, update, Date.now(), describe, env.ARCHIVE_EXPORT_ENABLED === '1' && exportServiceReady(env.EXPORT_DIR || '/exports'),
              platform => exportAccountNames(candidate, platform, { root: env.IG_ARCHIVE_DIR || '/downloads', stateDir }))) {
              atomic(settingsFile(env), candidate); settings = candidate;
            }
          }
          lastPollAt = Date.now(); pollOk = true;
        } catch (error) {
          if (stopping) return;
          if (!/^TELEGRAM_(?:ERROR_\d+|NETWORK_OR_RESPONSE_ERROR|RETRY_WAIT|UPDATES_INVALID)$/.test(error.message)) throw error;
          pollOk = false; log('TELEGRAM_CONTROL_POLL_FAILED', { reason: /^TELEGRAM_[A-Z0-9_]+$/.test(error.message) ? error.message : 'CONTROL_STATE_OR_IO_ERROR' });
          if (!args.includes('--once')) await wait(5000);
        }
      } while (!stopping && !args.includes('--once'));
    }
    async function replyDispatch() {
      do {
        if (env.ARCHIVE_EXPORT_ENABLED === '1') {
          const candidate = structuredClone(settings);
          let imported = false;
          try { imported = ingestExportReports(candidate, env.EXPORT_DIR || '/exports'); }
          catch { log('ARCHIVE_EXPORT_REPORT_FAILED', { reason: 'EXPORT_STATE_OR_IO_ERROR' }); }
          if (imported) { atomic(settingsFile(env), candidate); settings = candidate; }
        }
        await flushReplies(() => settings, client, persistSettings, { stopping: () => stopping, log });
        if (!args.includes('--once')) await wait(250);
      } while (!stopping && !args.includes('--once'));
    }
    async function dispatch() {
      do {
        const events = eventDirectory(env); fs.mkdirSync(events, { recursive: true });
        const names = fs.readdirSync(events).filter(n => /^[a-f0-9]{64}\.json$/.test(n)).slice(0, 100);
        const records = names.map(name => ({ file: path.join(events, name), event: load(path.join(events, name), null) })).sort((a,b) => a.event?.at - b.event?.at);
        for (const { file, event } of records) { delivery.ingest(event); fs.unlinkSync(file); }
        delivery.daily(Date.now(), describe);
        telegramOk = await delivery.drain(client, { stopping: () => stopping });
        health();
        if (!args.includes('--once')) await wait(1000);
      } while (!stopping && !args.includes('--once'));
    }
    async function manualDispatch() {
      do {
        await manual.drain(client, { stopping: () => stopping });
        if (!args.includes('--once')) await wait(1000);
      } while (!stopping && !args.includes('--once'));
    }
    async function xDispatch() {
      if (!xDelivery) return;
      do {
        xTelegramOk = await xDelivery.drain(client, { stopping: () => stopping });
        if (!args.includes('--once')) await wait(1000);
      } while (!stopping && !args.includes('--once'));
    }
    async function tikTokDispatch(lane) {
      do {
        ttOk[lane] = await ttDelivery.drain(client, { stopping: () => stopping, lane });
        if (!args.includes("--once")) await wait(1000);
      } while (!stopping && !args.includes("--once"));
    }
    if (args.includes('--once')) await poll();
    await Promise.all([...(args.includes('--once') ? [] : [poll()]), replyDispatch(), dispatch(), manualDispatch(), xDispatch(), tikTokDispatch('notice'), tikTokDispatch('video'), tikTokDispatch('content'), tikTokDispatch('story')]);
    if (args.includes('--once')) process.exitCode = pollOk && telegramOk && xTelegramOk && ttOk.video && ttOk.notice && ttOk.content && ttOk.story ? 0 : 1;
  } finally {
    stopping = true; signal.abort(); clearInterval(heartbeat);
    for (const name of ['SIGTERM', 'SIGINT']) process.off(name, stop);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch(error => { log('TELEGRAM_CONTROL_FATAL', { reason: error.code || (/^[A-Z0-9_]+$/.test(error.message) ? error.message : 'UNEXPECTED_ERROR') }); process.exitCode = 1; });
}
