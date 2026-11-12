import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { atomic, load } from './error-monitor.mjs';
import { downloadStory, archiveReason } from './story-archive.mjs';
import { manualPath, validManualFile } from './manual-files.mjs';
import { parseInstagramLink, manualJobId, shortcodeId } from './instagram-links.mjs';
import { validMediaUrl } from './story-media.mjs';
import { validUsername } from './telegram-settings.mjs';

export const jobDirectory = dir => path.join(dir, 'manual', 'jobs');
export function jobFile(dir, id) {
  if (!manualJobId(id)) throw Error('MANUAL_INVALID_JOB');
  return path.join(jobDirectory(dir), id + '.json');
}
export function fetchManual(plan, { signal, onChild = () => {}, env = process.env, script = '/app/src/fetch-manual.mjs' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ig-manual-')), resultFile = path.join(dir, 'result.json');
  return (async () => {
    try {
      await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [script], { env: { ...env, IG_MANUAL_PLAN: JSON.stringify(plan), IG_MANUAL_RESULT_FILE: resultFile }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
        onChild(child); let ok = false, reason = 'MANUAL_FETCH_FAILED';
        const kill = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} };
        const timeout = setTimeout(() => { reason = 'MANUAL_FETCH_TIMEOUT'; kill(); }, 120000);
        signal?.addEventListener('abort', kill, { once: true }); if (signal?.aborted) kill();
        readline.createInterface({ input: child.stdout }).on('line', line => {
          try { const row = JSON.parse(line); if (row.event === 'MANUAL_FETCH_RESULT') { ok = row.ok === true; if (/^(MANUAL|CATALOG)_[A-Z0-9_]+$/.test(row.reason || '')) reason = row.reason; } } catch {}
        });
        child.stderr.resume();
        child.on('error', () => { reason = 'MANUAL_PROCESS_START_FAILED'; });
        child.on('close', code => { clearTimeout(timeout); signal?.removeEventListener('abort', kill); onChild(null); code === 0 && ok && !signal?.aborted ? resolve() : reject(Error(reason)); });
      });
      return JSON.parse(fs.readFileSync(resultFile, 'utf8'));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  })();
}
export async function muxMedia(video, audio, destination, { signal, onChild = () => {} } = {}) {
  const temp = destination + '.mux.part.mp4';
  try {
    await new Promise((resolve, reject) => {
      const child = spawn('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', video, '-i', audio, '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy', '-movflags', '+faststart', temp], { detached: true, stdio: 'ignore' });
      onChild(child);
      const kill = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} };
      const timer = setTimeout(kill, 120000);
      signal?.addEventListener('abort', kill, { once: true }); if (signal?.aborted) kill();
      child.on('error', () => {});
      child.on('close', code => { clearTimeout(timer); signal?.removeEventListener('abort', kill); onChild(null); code === 0 && !signal?.aborted ? resolve() : reject(Error('MANUAL_MUX_FAILED')); });
    });
    const fd = fs.openSync(temp, 'r+'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temp, destination);
  } finally { fs.rmSync(temp, { force: true }); }
}
export class ManualJobs {
  constructor({ root, stateDir, settings, control, env = process.env, log = () => {}, fetcher = fetchManual, downloader = downloadStory, mux = muxMedia }) {
    Object.assign(this, { root, stateDir, settings, control, env, log, fetcher, downloader, mux });
    this.indexFile = path.join(stateDir, 'manual', 'cache.json');
  }
  persist(job) { atomic(jobFile(this.stateDir, job.id), job); }
  due() {
    const s = this.settings();
    return Object.values(s.manualRequests || {}).filter(r => s.allowedIds.includes(r.userId)).sort((a,b) => a.at - b.at).find(request => {
      let job;
      try {
        const file = jobFile(this.stateDir, request.id);
        job = load(file, null);
        if (!job && fs.existsSync(file)) throw Error('MANUAL_JOB_HISTORY_INVALID');
        if (job && (job.version !== 1 || job.id !== request.id || job.userId !== request.userId || job.url !== request.url || !['queued','working','retry','ready','failed'].includes(job.status) || !Number.isInteger(job.attempts) || job.attempts < 0 || !Array.isArray(job.files))) throw Error('MANUAL_JOB_HISTORY_INVALID');
      } catch {
        this.invalidJobs ||= new Set();
        if (!this.invalidJobs.has(request.id)) this.log('MANUAL_JOB_STATUS', { jobId: request.id, status: 'history-invalid', reason: 'MANUAL_JOB_HISTORY_INVALID' });
        this.invalidJobs.add(request.id); return false;
      }
      return !job || (['queued', 'working', 'retry'].includes(job.status) && Date.now() >= (job.retryAt || 0));
    });
  }
  cached(spec) {
    if (spec.kind === 'highlight') return null; // Refresh collection membership, then reuse its complete files.
    const index = load(this.indexFile, { version: 1, entries: {} });
    if (index.version !== 1 || !index.entries || typeof index.entries !== 'object' || Array.isArray(index.entries)) throw Error('MANUAL_CACHE_INVALID');
    const entry = index.entries[spec.identity]; if (!entry) return null;
    const manifest = load(manualPath(this.root, entry.folder + '/manifest.json'), null);
    if (!manifest || manifest.version !== 1 || manifest.identity !== entry.identity || !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length !== manifest.total || manifest.errors?.length) throw Error('MANUAL_CACHE_INVALID');
    try { for (const file of manifest.files) validManualFile(this.root, file); }
    catch (error) { if (error.code === 'ENOENT' || error.message === 'MANUAL_FILE_INCOMPLETE') return null; throw error; }
    return manifest;
  }
  async runOne() {
    const request = this.due(); if (!request || this.control.stopping) return false;
    let job = load(jobFile(this.stateDir, request.id), { version: 1, id: request.id, userId: request.userId, url: request.url, at: request.at, attempts: 0, files: [] });
    if (job.id !== request.id || job.userId !== request.userId || job.url !== request.url || !Number.isInteger(job.attempts) || !Array.isArray(job.files)) throw Error('MANUAL_JOB_HISTORY_INVALID');
    job.status = 'working'; job.attempts++; job.retryAt = 0; this.persist(job);
    const progress = (phase, seconds = 330) => this.log('MANUAL_WORK', { phase, seconds, jobId: job.id });
    try {
      manualPath(this.root, 'manual/.probe', { mkdir: true });
      const spec = parseInstagramLink(request.url);
      if (spec.kind === 'profile') throw Error('MANUAL_UNSUPPORTED_LINK');
      const cached = this.cached(spec);
      if (cached) { job.result = cached; job.status = 'ready'; job.reused = true; this.persist(job); return true; }
      progress('fetch', 150);
      const result = await this.fetcher(spec, { signal: this.control.signal, onChild: this.control.onChild, env: this.env });
      if (this.control.stopping) throw Error('MANUAL_STOPPING');
      if (result.version !== 1 || result.requestedUrl !== spec.url || result.guard?.blockedReadReceipt !== 0 || result.guard?.allowedRead !== 1 ||
          !validUsername(result.username) || !/^\d+$/.test(result.ownerId || '') || !['post','story','highlight'].includes(result.kind) ||
          !/^[A-Za-z0-9_-]{1,64}$/.test(result.contentId || '') || !Array.isArray(result.media) || !result.media.length || typeof result.caption !== 'string') throw Error('MANUAL_UNTRUSTED_RESULT');
      const resolved = parseInstagramLink(result.url);
      if (resolved.identity !== result.identity || resolved.kind !== result.kind || (spec.kind !== 'share' &&
          (result.identity !== spec.identity || result.kind !== spec.kind || result.contentId !== (spec.kind === 'post' ? shortcodeId(spec.shortcode) : spec.contentId) ||
           (spec.kind === 'story' && result.username !== spec.username)))) throw Error('MANUAL_TARGET_MISMATCH');
      if (new Set(result.media.map(m => m.id)).size !== result.media.length) throw Error('MANUAL_UNTRUSTED_RESULT');
      const folder = `manual/${result.username}/${result.kind}/${result.contentId}`;
      manualPath(this.root, folder, { mkdir: true, directory: true });
      const savedById = new Map();
      for (const old of job.result?.files || job.files || []) {
        try { validManualFile(this.root, old); savedById.set(old.id, old); } catch { /* Missing/incomplete files are downloaded again. */ }
      }
      const failures = new Map();
      const manifest = { version: 1, identity: result.identity, username: result.username, kind: result.kind, contentId: result.contentId,
        url: result.url, caption: result.caption, files: [], total: result.media.length, errors: [] };
      const snapshot = () => {
        manifest.files = result.media.map(item => savedById.get(item.id)).filter(Boolean);
        manifest.errors = result.media.filter(item => !savedById.has(item.id)).map(item => ({ id: item.id, reason: failures.get(item.id) || 'MANUAL_INTERRUPTED' }));
        job.files = manifest.files; job.result = manifest; this.persist(job);
      };
      snapshot();
      for (let i = 0; i < result.media.length; i++) {
        if (this.control.stopping || !this.settings().allowedIds.includes(request.userId)) throw Error('MANUAL_STOPPING');
        const item = result.media[i];
        if (!/^\d+(?:_\d+)?$/.test(item.id) || ![1,2].includes(item.mediaType) || !validMediaUrl(item.mediaUrl)) throw Error('MANUAL_UNTRUSTED_RESULT');
        const base = `${folder}/${String(i+1).padStart(3,'0')}_${item.id}`;
        manualPath(this.root, base);
        progress('download');
        try {
          if (savedById.has(item.id)) continue;
          let saved;
          const options = { signal: this.control.signal, timeoutMs: 300000, maxBytes: 2_000_000_000 };
          if (item.dash) {
            if (!validMediaUrl(item.dash.video?.url) || !validMediaUrl(item.dash.audio?.url)) throw Error('MANUAL_UNTRUSTED_RESULT');
            const final = manualPath(this.root, base + '.mp4');
            if (!fs.existsSync(final)) {
              const video = await this.downloader(this.root, base + '.video', { ...item, mediaUrl: item.dash.video.url }, options);
              progress('download');
              const audio = await this.downloader(this.root, base + '.audio', { ...item, mediaUrl: item.dash.audio.url }, options);
              progress('mux', 150);
              await this.mux(manualPath(this.root, video.relativePath), manualPath(this.root, audio.relativePath), final, { signal: this.control.signal, onChild: this.control.onChild });
              fs.unlinkSync(manualPath(this.root, video.relativePath)); fs.unlinkSync(manualPath(this.root, audio.relativePath));
            }
            saved = { relativePath: base + '.mp4', bytes: fs.statSync(final).size };
          } else saved = await this.downloader(this.root, base, item, options);
          const record = { ...saved, id: item.id, mediaType: item.mediaType, width: item.width, height: item.height };
          validManualFile(this.root, record); savedById.set(item.id, record);
        } catch (error) {
          if (this.control.signal.aborted) throw error;
          failures.set(item.id, /^MANUAL_[A-Z0-9_]+$/.test(error.message) ? error.message : archiveReason(error));
        }
        snapshot();
      }
      const { files, errors } = manifest;
      if (errors.length && job.attempts < 3) { job.status = 'retry'; job.retryAt = Date.now() + 60000 * job.attempts; }
      else {
        job.status = files.length ? 'ready' : 'failed'; job.reason = files.length ? undefined : errors[0]?.reason || 'MANUAL_DOWNLOAD_FAILED';
        if (!errors.length) {
          atomic(manualPath(this.root, folder + '/manifest.json'), manifest);
          const index = load(this.indexFile, { version: 1, entries: {} });
          index.entries[spec.identity] = index.entries[result.identity] = { folder, identity: result.identity }; atomic(this.indexFile, index);
        }
      }
      this.persist(job);
    } catch (error) {
      if (this.control.signal.aborted || this.control.stopping || error.message === 'MANUAL_STOPPING') {
        job.status = 'queued'; job.attempts = Math.max(0, job.attempts-1);
      } else {
        job.reason = /^(MANUAL|CATALOG)_[A-Z0-9_]+$/.test(error.message) ? error.message : archiveReason(error);
        const permanent = /INVALID|UNSUPPORTED|UNTRUSTED|MISMATCH|UNAVAILABLE|UNSAFE|SCHEMA|GUARD|INCOMPLETE|HTTP_404/.test(job.reason);
        job.status = !permanent && job.attempts < 3 ? 'retry' : job.result?.files?.length ? 'ready' : 'failed'; job.retryAt = Date.now() + 60000 * job.attempts;
      }
      this.persist(job);
    }
    this.log('MANUAL_JOB_STATUS', { jobId: job.id, status: job.status, reason: job.reason });
    return true;
  }
}
