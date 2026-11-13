import { telegramApiBase } from './telegram-endpoint.mjs';
import { ManualJobs } from './manual-jobs.mjs';
import { controlEnabled, readSettings, settingsFile, targetConfigs } from './telegram-settings.mjs';
import { notificationPublisher } from './telegram-events.mjs';
import { ensureAuthenticated } from './target-user.mjs';
import { configuredTargets, resolveTarget, sessionInvalid, aggregateHealth } from './targets.mjs';
import { accountArchiveRoot } from './archive-layout.mjs';
import { pathToFileURL } from 'node:url';
import { CatalogWatcher, fetchCatalog } from './catalog-watch.mjs';
import { StoryArchive } from './story-archive.mjs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { save, fetchStories } from './watch-story.mjs';
import { mediaRequest, validMediaUrl, enqueue, deliver, mediaFailureReason } from './story-media.mjs';

const emit = (event, data = {}) => console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...data }));

export async function main({ env = process.env, args = process.argv, dir = '/app/state', resolve = resolveTarget, fetcher = fetchStories, checkSession = ensureAuthenticated, sleepImpl, manualFetcher, manualDownloader } = {}) {
  const managed = controlEnabled(env);
  const currentConfigs = () => managed ? targetConfigs(readSettings(settingsFile(env))) : configuredTargets(env);
  const configs = currentConfigs();
  const notifications = managed ? notificationPublisher({ ...env, IG_STATE_DIR: dir }, target => entries.filter(e => e.target === target).map(e => e.config.username)) : null;
  const token = env.TELEGRAM_BOT_TOKEN || '';
  const chatId = env.TELEGRAM_CHAT_ID || '';
  const interval = Number(env.IG_CHECK_INTERVAL_SECONDS || 300);
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(token) || !chatId || !Number.isInteger(interval) || interval < 60 || interval > 86400) throw Error('INVALID_CONFIG');
  fs.mkdirSync(dir, { recursive: true });
  let stopping = false, child = null, wake = () => {};
  const aborter = new AbortController();
  const control = { get stopping() { return stopping; }, signal: aborter.signal, onChild: value => { child = value; } };
  const stop = () => {
    stopping = true; aborter.abort();
    if (child) try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    wake();
  };
  const sleep = delay => sleepImpl ? sleepImpl(delay) : new Promise(resolve => {
    const timer = setTimeout(resolve, delay);
    wake = () => { clearTimeout(timer); resolve(); };
    if (stopping) wake();
  });
  // One Telegram limiter for the shared destination, including retry_after across accounts.
  const rateFile = path.join(dir, 'telegram-rate.json');
  let lastSendAt = 0, retryAt = 0;
  if (fs.existsSync(rateFile)) {
    try { retryAt = JSON.parse(fs.readFileSync(rateFile, 'utf8')).retryAt; }
    catch { throw Error('INVALID_TELEGRAM_RATE_STATE'); }
    if (!Number.isFinite(retryAt) || retryAt < 0) throw Error('INVALID_TELEGRAM_RATE_STATE');
  }
  const telegram = async (method, body, state = {}, persist = () => {}) => {
    if (Date.now() < Math.max(retryAt, state.telegramRetryAt || 0)) throw Error('TELEGRAM_RETRY_WAIT');
    await sleep(Math.max(0, 1100 - (Date.now() - lastSendAt)));
    if (stopping) throw Error('TELEGRAM_STOPPING');
    lastSendAt = Date.now();
    let response, data;
    try {
      response = await fetch(`${telegramApiBase()}/bot${token}/${method}`, {
        method: 'POST', signal: AbortSignal.any([aborter.signal, AbortSignal.timeout(120000)]),
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, chat_id: chatId }),
      });
      data = await response.json();
    } catch { throw Error('TELEGRAM_NETWORK_OR_RESPONSE_ERROR'); }
    if (!response.ok || data.ok !== true) {
      const retry = Number(data.parameters?.retry_after);
      if (Number.isFinite(retry) && retry > 0) {
        retryAt = state.telegramRetryAt = Date.now() + retry * 1000;
        save(rateFile, { retryAt }); persist();
      }
      throw Error(`TELEGRAM_ERROR_${data.error_code || response.status}`);
    }
    state.telegramRetryAt = 0;
  };
  if (args.includes('--test-telegram')) {
    await telegram('sendMessage', { text: `IG 媒體通知設定成功\n${configs.map(c => '@' + c.username).join(', ')}\n每 ${interval} 秒檢查；圖片／影片將直接傳送。` });
    emit('TELEGRAM_TEST_OK'); return;
  }
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, stop);
  const manualJobs = managed ? new ManualJobs({ root: env.IG_ARCHIVE_DIR || '/downloads', stateDir: dir, settings: () => readSettings(settingsFile(env)), control, env, log: emit, fetcher: manualFetcher, downloader: manualDownloader }) : null;
  const makeEntry = config => ({ config, watcher: null, failures: 0, nextFetchAt: 0, nextCycleAt: 0, retryAt: 0, error: null,
    status() {
      const status = this.watcher ? { ...this.watcher.status(), username: this.config.username } : { target: this.target, username: this.config.username, failures: this.failures, nextFetchAt: this.nextFetchAt, telegramOk: true, archiveOk: true, catalogOk: true };
      return this.error ? { ...status, failures: Math.max(3, status.failures), nextFetchAt: this.retryAt } : status;
    },
  });
  let entries = configs.map(makeEntry);
  let sessionBlocked = null, sessionAlerted = false, sessionRecoveryPending = false;
  const notifySession = async () => {
    if (managed || env.IG_EXTERNAL_ERROR_MONITOR === '1') return;
    if (!sessionBlocked) {
      if (sessionRecoveryPending) {
        try { await telegram('sendMessage', { text: 'IG 共用登入已恢復，繼續監看所有帳號。' }); sessionRecoveryPending = false; }
        catch (error) { emit('TELEGRAM_DELIVERY_FAILED', { reason: error.message }); }
      }
      return;
    }
    if (sessionAlerted) return;
    try {
      await telegram('sendMessage', { text: 'IG 共用登入已失效，所有帳號暫停檢查。請重新登入；系統每五分鐘確認登入狀態。' });
      sessionAlerted = true;
    } catch (error) { emit('TELEGRAM_DELIVERY_FAILED', { reason: error.message }); }
  };
  const health = () => save(path.join(dir, 'health.json'), { ...aggregateHealth(entries), sessionOk: !sessionBlocked, ...(sessionBlocked ? { failures: 3 } : {}) });
  const heartbeat = setInterval(() => {
    try { health(); } catch { emit('WATCH_FATAL', { reason: 'HEALTH_WRITE_FAILED' }); process.exit(1); }
  }, 30000);
  const ids = new Set();
  emit('WATCH_MEDIA_STARTED', { targetCount: entries.length, intervalSeconds: interval,
    archiveEnabled: !!env.IG_ARCHIVE_DIR, catalogEnabled: env.IG_CATALOG_ENABLED === '1' });
  try {
    while (!stopping) {
      if (managed) {
        const desired = currentConfigs();
        const existing = new Map(entries.map(e => [e.config.username, e]));
        const previous = entries;
        entries = desired.map(config => existing.get(config.username) || makeEntry(config));
        for (const removed of previous) if (!entries.some(e => e.config.username === removed.config.username || (removed.target && e.target === removed.target))) {
          emit('WATCH_TARGET_REMOVED', { target: removed.target, username: removed.config.username });
        }
        ids.clear();
        for (const entry of entries) if (entry.target) ids.add(entry.target);
        if (!entries.length) sessionBlocked = null;
      }
      if (sessionBlocked && (!managed || Date.now() >= (sessionBlocked.probeAt || 0))) {
        try {
          // Clear any cached numeric ID: validate the shared login before resuming other targets.
          await checkSession(emit);
          sessionBlocked = null; emit('SHARED_SESSION_RECOVERED');
          sessionRecoveryPending = sessionAlerted; sessionAlerted = false;
        } catch {
          sessionBlocked.probeAt = Date.now() + 300000;
          emit('SHARED_SESSION_INVALID'); await notifySession();
          if (args.includes('--once')) { process.exitCode = 1; break; }
          emit('WATCH_WAIT', { seconds: managed ? 5 : 300 }); await sleep(managed ? 5000 : 300000); continue;
        }
      }
      if (manualJobs && await manualJobs.runOne()) {
        health();
        if (args.includes('--once')) break;
        emit('WATCH_WAIT', { seconds: 0 }); await sleep(1); continue;
      }
      // Resolve all due usernames first, so legacy ownership can be named even when
      // the old account is not the first entry in the new list.
      for (const entry of entries) {
        if (stopping || sessionBlocked || manualJobs?.due()) break;
        if (entry.target || Date.now() < entry.nextFetchAt) continue;
        const { config } = entry;
        const log = (event, data = {}) => emit(event, { ...data, username: config.username, target: config.username });
        try {
          const target = await resolve(config, env, log);
          if (!managed && ids.has(target)) throw Error('DUPLICATE_TARGET_ACCOUNT');
          ids.add(target); entry.target = target; entry.failures = 0;
        } catch (error) {
          if (error.message === 'DUPLICATE_TARGET_ACCOUNT') throw error;
          entry.failures++;
          entry.nextFetchAt = Date.now() + Math.min(interval * 2 ** Math.min(entry.failures, 5), Math.max(interval, 1800)) * 1000;
          log('WATCH_CHECK_FAILED', { reason: error.message, consecutiveFailures: entry.failures });
          if (sessionInvalid(error)) { sessionBlocked = { ...config, probeAt: Date.now() + 300000 }; emit('SHARED_SESSION_INVALID'); break; }
        }
        if (entries.length > 1 && entry !== entries.at(-1) && !stopping) {
          emit('WATCH_TARGET_PAUSE', { seconds: 2 }); await sleep(2000);
        }
      }
      const ownerNames = {};
      for (const e of entries) if (e.target && (!ownerNames[e.target] || /^\d+$/.test(ownerNames[e.target]))) ownerNames[e.target] = e.config.username;
      const processedIds = new Set();
      for (const scheduled of entries) {
        const group = entries.filter(e => e.target && e.target === scheduled.target);
        const entry = group.find(e => !/^\d+$/.test(e.config.username)) || scheduled;
        if (processedIds.has(entry.target)) continue;
        processedIds.add(entry.target);
        if (stopping || sessionBlocked || manualJobs?.due()) break;
        if (!entry.target || Date.now() < entry.retryAt || Date.now() < entry.nextCycleAt) continue;
        const { config, target } = entry;
        try {
          if (!entry.watcher || entry.watcher.status().username !== config.username) {
            const root = env.IG_ARCHIVE_DIR ? accountArchiveRoot(env.IG_ARCHIVE_DIR, dir, target, config.username, ownerNames) : null;
            entry.watcher = createTargetWatcher({ target, username: config.username, dir, root, interval, control, telegram, env, fetcher, notifications, yieldToManual: () => !!manualJobs?.due() });
            for (const alias of group) alias.watcher = entry.watcher;
            emit('WATCH_TARGET_READY', { target, username: config.username, usernames: group.map(e => e.config.username) });
          }
          const cycle = await entry.watcher.cycle();
          emit('WATCH_TARGET_COMPLETED', { target, username: config.username, usernames: group.map(e => e.config.username) });
          entry.error = null; entry.retryAt = 0;
          entry.nextCycleAt = cycle?.yielded ? 0 : Date.now() + Math.max(1000, Math.min(interval * 1000, entry.watcher.status().nextFetchAt - Date.now()));
        } catch (error) {
          if (error.message === 'SHARED_SESSION_INVALID') { sessionBlocked = { ...config, probeAt: Date.now() + 300000 }; emit('SHARED_SESSION_INVALID'); break; }
          // Preserve the in-memory queue after a failed write. Only this account pauses.
          entry.error = error.code || (/^[A-Z0-9_]+$/.test(error.message) ? error.message : 'TARGET_RUNTIME_ERROR');
          entry.retryAt = Date.now() + 300000;
          emit('WATCH_TARGET_FAILED', { target, username: config.username, usernames: group.map(e => e.config.username), reason: entry.error });
        }
        for (const alias of group) { alias.watcher = entry.watcher; alias.error = entry.error; alias.retryAt = entry.retryAt; alias.nextCycleAt = entry.nextCycleAt; }
        health();
        if (entries.length > 1 && entry !== entries.at(-1) && !stopping) {
          emit('WATCH_TARGET_PAUSE', { seconds: 2 }); await sleep(2000);
        }
      }
      await notifySession();
      if (!managed && env.IG_EXTERNAL_ERROR_MONITOR !== '1') {
        for (const entry of entries) {
          const reason = entry.error || (entry.failures >= 3 ? 'TARGET_LOOKUP_FAILED' : null);
          if (reason === (entry.notifiedReason || null)) continue;
          try {
            await telegram('sendMessage', { text: reason
              ? `IG 帳號監看異常：@${entry.config.username}\n${reason}\n此帳號將獨立重試，其他帳號繼續檢查。`
              : `IG 帳號監看已恢復：@${entry.config.username}` });
            entry.notifiedReason = reason;
          } catch (error) { emit('TELEGRAM_DELIVERY_FAILED', { username: entry.config.username, reason: error.message }); }
        }
      }
      health();
      if (args.includes('--once')) {
        const status = aggregateHealth(entries);
        process.exitCode = sessionBlocked || status.failures || !status.telegramOk || !status.archiveOk || !status.catalogOk ? 1 : 0;
        break;
      }
      const delay = sessionBlocked ? (managed ? 5000 : 300000) : Math.max(1000, Math.min(managed ? 5000 : interval * 1000, ...entries.map(e => (e.error ? e.retryAt : e.nextCycleAt || e.nextFetchAt) - Date.now())));
      emit('WATCH_WAIT', { seconds: Math.ceil(delay / 1000) }); await sleep(delay);
    }
  } finally {
    clearInterval(heartbeat);
    for (const signal of ['SIGTERM', 'SIGINT']) process.off(signal, stop);
  }
  emit('WATCH_STOPPED');
}

export function createTargetWatcher({ target, username, dir, root, interval, control, telegram, env = process.env, fetcher = fetchStories, notifications = null, yieldToManual = () => false }) {
  const log = (event, data = {}) => emit(event, { ...data, target, username, ...(notifications ? { usernames: notifications.aliases(target) } : {}) });
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
  const callTelegram = (method, body) => telegram(method, body, state, persist);
  const sendText = text => notifications || env.IG_EXTERNAL_ERROR_MONITOR === '1'
    ? Promise.resolve()
    : callTelegram('sendMessage', { text, link_preview_options: { is_disabled: true } });
  const sendMedia = story => {
    if (notifications) return Promise.resolve(); // Per-user delivery is durably delegated from each fresh snapshot.
    const request = mediaRequest({ ...story, username }, '');
    return callTelegram(request.method, request.body);
  };
  const archive = root ? new StoryArchive({
    root: root, stateDir: dir, target, log,
  }) : null;
  // Include old Telegram retries, but keep archive history independent of sent IDs.
  if (archive) archive.enqueue(Object.values(state.pending));
  const catalog = env.IG_CATALOG_ENABLED === '1' ? new CatalogWatcher({
    root: root || '', stateDir: dir, target, username, log,
    postsInterval: Number(env.IG_POSTS_INTERVAL_SECONDS || 900),
    fetcher: (plan, options) => fetchCatalog(plan, { ...options, env: { ...env, IG_TARGET_USERNAMES: '', IG_TARGET_USERNAME: username, IG_TARGET_USER_ID: target } }),
    highlightsInterval: Number(env.IG_HIGHLIGHTS_INTERVAL_SECONDS || 900),
  }) : null;
  let nextFetchAt = 0, telegramOk = true, archiveOk = true, catalogOk = true;
  return {
    status: () => ({ target, username, failures: state.failures, telegramOk, archiveOk, catalogOk, nextFetchAt }),
    async cycle() {
      log('WATCH_TARGET_STARTED');
      if (Date.now() >= nextFetchAt) {
        const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ig-media-'));
        const resultFile = path.join(temp, 'result.json');

        let archiveStories = null;
        try {
          const summary = await fetcher('/app/src/fetch-story.mjs', control.onChild, 120000, { ...env, IG_TARGET_USERNAMES: '', IG_TARGET_USERNAME: username, IG_TARGET_USER_ID: target, IG_STORY_RESULT_FILE: resultFile });
          if (control.stopping) return;
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
          if (notifications) notifications.stories(username, target, media.stories);
          enqueue(state, media);
          archiveStories = media.stories;
          state.failures = 0;
          state.lastSuccess = new Date().toISOString();
          log('WATCH_MEDIA_CHECK_OK', { storyCount: summary.storyCount, mediaCount: media.storyCount,
            skippedCount: media.skippedIds.length, skippedIds: media.skippedIds, mediaIds: media.stories.map(s => s.id), pendingCount: Object.keys(state.pending).length });
        } catch (error) {
          if (control.stopping) return;
          state.failures++;
          state.lastError = mediaFailureReason(error);
          if (sessionInvalid(error)) { persist(); throw Error('SHARED_SESSION_INVALID'); }
          log('WATCH_CHECK_FAILED', { consecutiveFailures: state.failures, reason: state.lastError });
        } finally {
          fs.rmSync(temp, { recursive: true, force: true });
        }
        // Persist outside the fetch catch: archive history errors must be fatal and visible.
        if (archive && archiveStories) archive.enqueue(archiveStories);
        nextFetchAt = Date.now() + Math.min(interval * 2 ** Math.min(state.failures, 5), Math.max(interval, 1800)) * 1000;
        persist();
      }
      if (yieldToManual()) { persist(); return { yielded: true }; }
      // Bounded download phase; Telegram still runs when archive downloads fail.
      if (archive && !control.stopping) archiveOk = await archive.run(control.signal, { shouldYield: yieldToManual });
      if (yieldToManual()) { persist(); return { yielded: true }; }
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
          (id, mediaType) => log(notifications ? 'STORY_MEDIA_QUEUED' : 'STORY_MEDIA_SENT', { id, type: mediaType === 2 ? 'video' : 'photo' }),
          (id, reason) => log('STORY_MEDIA_RETRY', { id, reason }), () => control.stopping);
        // A permanently unavailable URL must not block newer Story deliveries.
        const failed = Object.values(state.pending).filter(s => s.deliveryFailures >= 3 && !s.failureNotified).slice(0, 5);
        for (const story of failed) {
          if (control.stopping) return;
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
      if (catalog && !control.stopping) {
        await catalog.check(control.signal, control.onChild, { shouldYield: yieldToManual });
        if (yieldToManual()) { persist(); return { yielded: true }; }
        if (!control.stopping) catalogOk = await catalog.deliver(control.signal,
          (method, body, metadata) => notifications
            ? Promise.resolve(notifications.media(username, target, method, body, metadata))
            : callTelegram(method, body), { shouldYield: yieldToManual });
      }
      persist();
      return { yielded: yieldToManual() };
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { emit('WATCH_FATAL', { reason: error.code || (/^[A-Z0-9_]+$/.test(error.message) ? error.message : 'UNEXPECTED_ERROR') }); process.exitCode = 1; });
}
