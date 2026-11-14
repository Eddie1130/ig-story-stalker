const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const validTimestamp = value => Number.isFinite(value) && value >= 0 && value <= 8640000000000000;
const username = value => typeof value === 'string' && /^[a-z0-9_]{1,15}$/.test(value) ? value : 'unknown';
const boundedString = (value, max) => typeof value === 'string' && value.length <= max ? value : '';
const ownLabel = (labels, key) => Object.hasOwn(labels, key) ? labels[key] : undefined;
const liveStatuses = new Set(['working', 'running', 'importing']);
const errorStatuses = new Set(['retry', 'failed', 'partial', 'needs_start']);
const statusLabels = { queued: '排隊中', working: '執行中', running: '執行中', importing: '匯入中', retry: '等待重試',
  complete: '搜尋完成', ready: '完成', partial: '部分完成', needs_start: '請指定回補起日', failed: '失敗', cancelled: '已取消' };
const passLabels = { search_main: '主搜尋', search_replies: '回覆', search_media: '媒體', search_verify: '交叉驗證' };
const actionLabels = { resolve: '解析帳號與建立日期', timeline_posts: '抓取近期貼文與回覆時間軸', timeline_media: '抓取近期媒體時間軸',
  export: '匯出貼文資料', importing: '匯入共用封存紀錄', archive: '下載／檢查本機媒體', rendering: '產生 Markdown 與媒體清單',
  finished: '流程已結束', queued: '等待前方歷史回補任務', needs_start: '請指定回補起日，再重新申請' };
const hongKongTime = new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Hong_Kong', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });

function presentableJob(value) {
  const job = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return { ...job, status: boundedString(job.status, 32), phase: boundedString(job.phase, 40), reason: boundedString(job.reason, 81),
    username: boundedString(job.username, 15), id: boundedString(job.id, 128) };
}

function date(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const timestamp = Date.parse(value + 'T00:00:00Z');
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value ? value : null;
}
function heading(job) {
  const posts = count(job.posts ?? job.count ?? job.progress?.posts);
  const reason = errorStatuses.has(job.status) && /^[A-Z][A-Z0-9_]{0,80}$/.test(job.reason || '') ? `（${job.reason}）` : '';
  const successful = ['complete', 'ready'].includes(job.status);
  const label = job.phase === 'finished' && job.reported === true && successful ? '封存完成' :
    ['archive', 'rendering'].includes(job.phase) && successful ? '封存中（搜尋完成）' : ownLabel(statusLabels, job.status) || '狀態待確認';
  return `${job.gap === true ? '監控缺口補抓' : '歷史回補'} @${username(job.username)}：${label}${reason}${posts === null ? '' : `；貼文資料 ${posts} 篇`}`;
}
function windowProgress(job) {
  const progress = job.progress || {};
  const done = count(progress.completedWindows), total = count(progress.totalWindows);
  const partial = count(progress.partialWindows), failed = count(progress.failedWindows);
  const errors = `${partial ? `，部分完成 ${partial}` : ''}${failed ? `，失敗 ${failed}` : ''}`;
  if (done === null || total === null || total === 0) return `完成視窗 ${done ?? '待更新'}；總數待更新${errors}`;
  const boundedDone = Math.min(done, total);
  const incomplete = partial > 0 || failed > 0 || done > total;
  const percentage = Math.min(incomplete ? 99 : 100, Math.floor(boundedDone / total * 100));
  return `完成視窗 ${boundedDone}/${total}（${percentage}%），剩餘 ${Math.max(0, total - boundedDone)}${errors}`;
}
function currentAction(job) {
  if (job.status === 'needs_start') return actionLabels.needs_start;
  if (job.status === 'queued') return actionLabels.queued;
  if (job.phase === 'waiting' || job.status === 'retry') return /LIMIT|LOCK|WAIT|NO_ACCOUNT|POOL/.test(job.reason || '')
    ? '帳號限流／暫無可用登入，等待重試' : '等待可用帳號或暫時失敗後重試';
  if (job.phase === 'search') {
    const pass = job.progress?.currentPass;
    return pass === 'search_replies' ? '回覆補抓' : pass === 'search_media' ? '媒體補抓' : pass === 'search_verify' ? '交叉驗證補抓' : '搜尋歷史貼文';
  }
  return ownLabel(actionLabels, job.phase) || '工作進度待更新';
}
function passProgress(progress) {
  if (!Array.isArray(progress?.passes)) return null;
  return Object.entries(passLabels).map(([name, label]) => {
    const pass = progress.passes.find(pass => pass && pass.name === name);
    const total = count(pass?.total), done = count(pass?.completed);
    if (total === null || done === null) return `${label} 待更新`;
    const errors = `${count(pass?.partial) ? `，部分 ${pass.partial}` : ''}${count(pass?.failed) ? `，失敗 ${pass.failed}` : ''}`;
    return `${label} ${Math.min(done, total)}/${total}${errors}`;
  }).join('；');
}
function archiveProgress(job) {
  if (job.status === 'importing' || job.phase === 'importing') {
    const imported = count(job.importedPosts), total = count(job.posts);
    return `匯入貼文資料：${imported === null || total === null ? '進度待更新' : `${Math.min(imported, total)}/${total} 篇`}；媒體待匯入完成後排程。`;
  }
  if (job.fetchDone === false || (!job.fetchDone && liveStatuses.has(job.status) && !['archive', 'rendering', 'finished'].includes(job.phase)))
    return '本機封存：媒體下載尚未開始，等待搜尋／匯入後排程。';
  const archive = job.archive;
  const total = count(archive?.total), done = count(archive?.done), failed = count(archive?.failed);
  if (archive?.unit !== 'post' || total === null || done === null) return '本機封存：處理進度待更新（篇數與檔案數不同）。';
  const boundedDone = Math.min(done, total), remaining = Math.max(0, total - boundedDone);
  return `本機封存：已處理 ${boundedDone}/${total} 篇，剩餘 ${remaining} 篇${failed ? `，失敗 ${failed} 篇` : ''}${remaining || failed ? '；媒體仍待完成。' : '（篇數，非檔案數）。'}`;
}
function retryTime(job, now) {
  if (job.status !== 'retry' || !validTimestamp(job.retryAt) || !job.retryAt) return null;
  const seconds = Math.max(0, Math.ceil((job.retryAt - now) / 1000));
  const duration = seconds >= 3600 ? `約 ${Math.ceil(seconds / 3600)} 小時後` : seconds >= 60 ? `約 ${Math.ceil(seconds / 60)} 分鐘後` : seconds ? `約 ${seconds} 秒後` : '已到重試時間';
  return `下次嘗試：香港時間 ${hongKongTime.format(new Date(job.retryAt))}（${duration}）`;
}

/** Present only safe, bounded job fields; search coverage never claims media completion. */
export function formatXHistory(value, now = Date.now()) {
  const job = presentableJob(value);
  const lines = [`${heading(job)}；${windowProgress(job)}`, `目前：${currentAction(job)}`];
  const start = date(job.start), end = date(job.end);
  lines.push(start && end && start < end ? `範圍：${start} → ${end} UTC（結束日不含）` : '範圍：起訖日期待更新');
  const passes = passProgress(job.progress);
  if (passes) lines.push(`分輪：${passes}`);
  const windowStart = date(job.progress?.windowStart), windowEnd = date(job.progress?.windowEnd);
  if (job.phase === 'search' && windowStart && windowEnd && windowStart < windowEnd) lines.push(`目前視窗：${windowStart} → ${windowEnd} UTC（結束日不含）`);
  lines.push(archiveProgress(job));
  const retry = retryTime(job, now);
  if (retry) lines.push(retry);
  const updated = validTimestamp(job.progressUpdatedAt) ? job.progressUpdatedAt : validTimestamp(job.at) ? job.at : null;
  const footer = [updated === null ? '更新：時間待取得' : `更新：香港時間 ${hongKongTime.format(new Date(updated))}`];
  const archiveInProgress = job.reported !== true && ['archive', 'rendering'].includes(job.phase) && !['failed', 'cancelled', 'needs_start'].includes(job.status);
  if ((liveStatuses.has(job.status) || archiveInProgress) && !['waiting', 'finished'].includes(job.phase) && job.status !== 'retry' &&
      updated !== null && now - updated > 300000) footer.push('進度超過 5 分鐘未更新，顯示的資料可能已過期。');
  const tail = footer.join('\n'), text = lines.join('\n'), budget = 750 - tail.length - 1;
  return `${text.length > budget ? text.slice(0, budget - 1) + '…' : text}\n${tail}`;
}

export function compactXHistory(value) {
  const job = presentableJob(value);
  return `${heading(job)}；${currentAction(job)}`.slice(0, 180);
}
