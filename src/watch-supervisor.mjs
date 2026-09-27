import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { Issues, atomic, load, safe, log, eventIssue } from './error-monitor.mjs';

const dir = process.env.IG_MONITOR_DIR || '/app/state/monitor';
let worker, stopping = false, tick, wake = () => {};
let health = { at: Date.now(), workerDeadline: Date.now() + 150000, phase: 'starting', lastCheckAt: null };
const writeHealth = () => atomic(path.join(dir, 'health.json'), { ...health, at: Date.now() });
const terminate = () => { if (worker?.pid) try { process.kill(-worker.pid, 'SIGTERM'); } catch {} };
function fatal(error) {
  clearInterval(tick); terminate();
  log('SUPERVISOR_FATAL', { reason: safe(error.code || error.message || 'UNKNOWN') });
  try { health.phase = 'fatal'; writeHealth(); } catch {}
  // Container termination also stops any surviving Chromium descendants.
  process.exit(1);
}
process.on('uncaughtException', fatal);
process.on('unhandledRejection', fatal);
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
  stopping = true; terminate(); wake();
  setTimeout(() => { if (worker?.pid) try { process.kill(-worker.pid, 'SIGKILL'); } catch {} }, 5000).unref();
});
async function main() {
  const target = process.env.IG_TARGET_USERNAME || process.env.IG_TARGET_USER_ID || 'unknown';
  const issues = new Issues(path.join(dir, 'issues.json'), path.join(dir, 'outbox'), '@' + target);
  const started = Date.now();
  let peerCheckBusy = false, peerAlerted = false, peerAttemptAt = 0;
  async function checkWatchdog() {
    if (peerCheckBusy || stopping || Date.now() - started < 180000) return;
    peerCheckBusy = true;
    try {
      let peer;
      try { peer = load(path.join(process.env.IG_WATCHDOG_DIR || '/app/watchdog-state', 'health.json'), null); } catch {}
      if (peer && Number.isFinite(peer.at) && Date.now() - peer.at < 180000) {
        issues.resolve('watchdog-heartbeat'); peerAlerted = false; return;
      }
      issues.fail('watchdog-heartbeat', 'WATCHDOG_HEARTBEAT_STALE');
      if (peerAlerted || Date.now() - peerAttemptAt < 60000) return;
      peerAttemptAt = Date.now();
      try {
        const r = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
          method: 'POST', signal: AbortSignal.timeout(20000), headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID,
            text: `IG watchdog 心跳已中斷：@${target}\n這則備援警報由主監控直接發出。請檢查 ig-watchdog 容器。` }),
        });
        const body = await r.json();
        if (!r.ok || body.ok !== true) throw Error('FALLBACK_SEND_FAILED');
        peerAlerted = true; log('WATCHDOG_FALLBACK_ALERT_SENT');
      } catch { log('WATCHDOG_FALLBACK_ALERT_FAILED'); }
    } finally { peerCheckBusy = false; }
  }
  writeHealth();
  tick = setInterval(() => {
    health.activeIssues = issues.activeCount();
    writeHealth();
    checkWatchdog().catch(fatal);
    if (!stopping && worker && Date.now() > health.workerDeadline) {
      issues.fail('worker-stall', 'WORKER_PROGRESS_DEADLINE_EXCEEDED');
      fatal(Error('WORKER_STALLED_RESTARTING_CONTAINER'));
    }
  }, 15000);
  log('SUPERVISOR_STARTED');
  let restarts = 0;
  while (!stopping) {
    health.phase = 'starting'; health.workerDeadline = Date.now() + 150000; writeHealth();
    const result = await new Promise(resolve => {
      worker = spawn(process.execPath, ['/app/src/watch-media.mjs'], {
        detached: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, IG_EXTERNAL_ERROR_MONITOR: '1' },
      });
      const stdout = readline.createInterface({ input: worker.stdout });
      stdout.on('line', line => {
        let row;
        try { row = JSON.parse(line); if (typeof row?.event !== 'string') throw Error(); }
        catch { issues.fail('worker-output', 'UNPARSEABLE_WORKER_OUTPUT'); return; }
        console.log(line);
        const problem = eventIssue(row); if (problem) issues.fail(...problem);
        const now = Date.now();
        health.lastEvent = row.event;
        if (row.event === 'WATCH_MEDIA_STARTED') {
          health.phase = 'fetching'; health.workerDeadline = now + 150000;
        } else if (row.event === 'WATCH_MEDIA_CHECK_OK') {
          health.phase = 'delivering';
          health.lastCheckAt = now; health.storyCount = row.storyCount;
          health.workerDeadline = now + 150000;
          for (const key of ['fetch', 'worker-exit', 'worker-fatal', 'worker-stall', 'worker-stderr', 'worker-output']) issues.resolve(key);
          if (row.skippedCount === 0) issues.resolve('skipped-media');
          for (const id of row.skippedIds || []) issues.fail(`missing-media:${safe(id)}`, 'STORY_HAS_NO_MEDIA_VARIANT');
          for (const id of row.mediaIds || []) issues.resolve(`missing-media:${safe(id)}`);
          restarts = 0;
        } else if (row.event === 'STORY_MEDIA_SENT') {
          issues.resolve(`media:${safe(row.id)}`); issues.resolve('worker-telegram');
          health.workerDeadline = now + 150000;
        } else if (row.event === 'STORY_MEDIA_RETRY' || row.event === 'WATCH_CHECK_FAILED' || row.event === 'TELEGRAM_DELIVERY_FAILED') {
          health.workerDeadline = now + 150000;
        } else if (row.event === 'WATCH_WAIT') {
          if (!Number.isFinite(row.seconds) || row.seconds < 0 || row.seconds > 86400) {
            issues.fail('worker-output', 'INVALID_WAIT_DURATION'); return;
          }
          health.phase = 'waiting'; health.workerDeadline = now + row.seconds * 1000 + 150000;
        }
        health.activeIssues = issues.activeCount(); writeHealth();
      });
      const stderr = readline.createInterface({ input: worker.stderr });
      stderr.on('line', () => issues.fail('worker-stderr', 'WORKER_STDERR_DETECTED_SEE_LOCAL_RUNTIME'));
      worker.on('error', error => issues.fail('worker-exit', safe(error.code || 'SPAWN_FAILED')));
      worker.on('close', (code, signal) => { worker = null; resolve({ code, signal }); });
    });
    if (stopping) break;
    issues.fail('worker-exit', `WORKER_EXIT code=${result.code} signal=${result.signal}`);
    const delay = Math.min(15000 * 2 ** Math.min(restarts++, 5), 300000);
    health.phase = 'restarting'; health.workerDeadline = Date.now() + delay + 150000; writeHealth();
    await new Promise(resolve => { const t = setTimeout(resolve, delay); wake = () => { clearTimeout(t); resolve(); }; if (stopping) wake(); });
  }
  clearInterval(tick); health.phase = 'stopped'; writeHealth();
  log('SUPERVISOR_STOPPED');
}
main().catch(fatal);
