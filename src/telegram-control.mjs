import { ManualDelivery } from './manual-delivery.mjs';
import { flushReplies } from './telegram-replies.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { atomic, load, log } from './error-monitor.mjs';
import { settingsFile, initializeSettings } from './telegram-settings.mjs';
import { eventDirectory } from './telegram-events.mjs';
import { applyUpdate } from './telegram-menu.mjs';
import { PersonalDelivery } from './telegram-delivery.mjs';
import { TelegramClient } from './telegram-client.mjs';

export function describeUser(settings, id, stateDir, watchdogDir = null) {
  let readErrors = 0;
  const read = (file, fallback) => { try { return load(file, fallback); } catch { readErrors++; return fallback; } };
  const user = settings.users[id], health = read(path.join(stateDir, 'health.json'), null);
  const targets = Array.isArray(health?.targets) ? health.targets : [];
  const names = Object.keys(user?.targets || {});
  const lines = ['你的監看狀態', `每日摘要：${user?.daily ? '開啟' : '關閉'}（異常與恢復通知保持開啟）`];
  if (!names.length) lines.push('尚未加入任何監看帳號。');
  for (const name of names) {
    const target = targets.find(t => t?.username === name);
    const catalog = target?.target && /^\d+$/.test(target.target) ? read(path.join(stateDir, `catalog-${target.target}.json`), null) : null;
    const assets = Object.values(catalog?.assets || {});
    const pending = assets.filter(a => !a?.archiveDone).length;
    lines.push(`@${name}：${!target ? '等待解析帳號' : target.failures ? '檢查異常／重試中' : '監看中'}；貼文／精選已下載 ${assets.length - pending}，待下載 ${pending}`);
  }
  const issues = { ...read(path.join(stateDir, 'monitor/issues.json'), {}), ...(watchdogDir ? read(path.join(watchdogDir, 'issues.json'), {}) : {}) };
  const targetIds = new Set(targets.filter(t => t && names.includes(t.username)).map(t => t.target));
  const relevant = Object.entries(issues).filter(([key, v]) => v?.active && (!key.startsWith('target:') || targetIds.has(v.target) || v.usernames?.some(name => names.includes(name)) || names.some(name => key.startsWith(`target:${name}:`))));
  lines.push(`目前異常：${relevant.length}`, ...relevant.slice(0, 6).map(([key, v]) => `${key}：${v.reason}`));
  if (readErrors) lines.push(`有 ${readErrors} 份執行狀態讀取失敗，請檢查監控日誌。`);
  if (health && (!Number.isFinite(health.at) || Date.now() - health.at > 120000)) lines.push('監看程序心跳已過期，顯示的是先前紀錄。');
  return lines.join('\n').slice(0, 3400);
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
  let stopping = false, telegramOk = true, pollOk = true, lastPollAt = Date.now();
  const stop = () => { stopping = true; signal.abort(); };
  for (const name of ['SIGTERM', 'SIGINT']) process.on(name, stop);
  const wait = ms => new Promise(resolve => { const t = setTimeout(done, ms); function done() { clearTimeout(t); signal.signal.removeEventListener('abort', done); resolve(); } signal.signal.addEventListener('abort', done, { once: true }); if (stopping) done(); });
  const client = new TelegramClient({ token: env.TELEGRAM_BOT_TOKEN, dir, signal: signal.signal, sleep: wait });
  const delivery = new PersonalDelivery({ dir, stateDir, settings: () => settings, log });
  const manual = new ManualDelivery({ root: env.IG_ARCHIVE_DIR || '/downloads', dir, stateDir, settings: () => settings, log });
  const persistSettings = () => atomic(settingsFile(env), settings);
  const describe = id => describeUser(settings, id, stateDir, env.IG_WATCHDOG_DIR || '/app/watchdog-state');
  const health = () => atomic(path.join(dir, 'health.json'), { at: Date.now(), telegramOk, pollOk, lastPollAt, pending: Object.keys(delivery.state.pending).length });
  const heartbeat = setInterval(health, 15000);
  try {
    // Do not silently delete another deployment's webhook or pending updates.
    const webhook = await client.call('getWebhookInfo', {}, { polling: true });
    if (webhook?.url) throw Error('TELEGRAM_WEBHOOK_CONFIGURED');
    await client.call('setMyCommands', { commands: [{ command: 'menu', description: '開啟個人設定選單' }, { command: 'status', description: '查看我的監看狀態' }, { command: 'add', description: '新增監看帳號，例如 /add alice' }, { command: 'cancel', description: '取消目前操作' }, { command: 'download', description: '貼上 Instagram 連結下載原檔' }] });
    await client.call('setChatMenuButton', { menu_button: { type: 'commands' } });
    health(); log('TELEGRAM_CONTROL_STARTED');
    async function poll() {
      do {
        try {
          const updates = await client.call('getUpdates', { offset: settings.offset, timeout: args.includes('--once') ? 0 : 10, allowed_updates: ['message', 'callback_query'], limit: 50 }, { polling: true });
          if (!Array.isArray(updates)) throw Error('TELEGRAM_UPDATES_INVALID');
          for (const update of updates) {
            const candidate = structuredClone(settings);
            if (applyUpdate(candidate, update, Date.now(), describe)) {
              atomic(settingsFile(env), candidate); settings = candidate;
            }
          }
          lastPollAt = Date.now(); pollOk = true;
          await flushReplies(settings, client, persistSettings, { stopping: () => stopping, log });
        } catch (error) {
          if (stopping) return;
          if (!/^TELEGRAM_(?:ERROR_\d+|NETWORK_OR_RESPONSE_ERROR|RETRY_WAIT|UPDATES_INVALID)$/.test(error.message)) throw error;
          pollOk = false; log('TELEGRAM_CONTROL_POLL_FAILED', { reason: /^TELEGRAM_[A-Z0-9_]+$/.test(error.message) ? error.message : 'CONTROL_STATE_OR_IO_ERROR' });
          if (!args.includes('--once')) await wait(5000);
        }
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
    await Promise.all([poll(), dispatch(), manualDispatch()]);
    if (args.includes('--once')) process.exitCode = pollOk && telegramOk ? 0 : 1;
  } finally {
    stopping = true; signal.abort(); clearInterval(heartbeat);
    for (const name of ['SIGTERM', 'SIGINT']) process.off(name, stop);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch(error => { log('TELEGRAM_CONTROL_FATAL', { reason: error.code || (/^[A-Z0-9_]+$/.test(error.message) ? error.message : 'UNEXPECTED_ERROR') }); process.exitCode = 1; });
}
