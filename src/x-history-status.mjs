import path from 'node:path';

// Shared by the status page and platform menus; scope all job sources to this user's accounts.
export function xHistoryReports(user, settings, id, stateDir, read, xHealth) {
  const xNames = Object.keys(user?.xTargets || {});
  if (xNames.length) {
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
    const priority = job => ['working', 'running', 'importing'].includes(job.status) || ['archive', 'rendering'].includes(job.phase) ? 0 : job.status === 'retry' ? 1 : 2;
    const requestedAt = job => Number.isFinite(job.requestedAt) ? job.requestedAt : Number.isFinite(job.at) ? job.at : 0;
    return reports.sort((a, b) => priority(a) - priority(b) || requestedAt(a) - requestedAt(b));
  }
  return [];
}
