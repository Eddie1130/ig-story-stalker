import fs from 'node:fs';
import path from 'node:path';
import { load } from './error-monitor.mjs';

const maps = { ig: 'targets', x: 'xTargets', tt: 'tiktokTargets' };
const patterns = { ig: /^[a-z0-9_.]{1,30}$/, x: /^[a-z0-9_]{1,15}$/, tt: /^[a-z0-9_][a-z0-9_.]{0,23}$/ };
const validName = (platform, name) => Object.hasOwn(patterns, platform) && typeof name === 'string' && !['.', '..', 'manual'].includes(name) && patterns[platform].test(name);
export function exportGeneration(settings, id, platform, name) {
  if (!settings.allowedIds.includes(id) || !validName(platform, name)) return undefined;
  if (id === settings.ownerId) return 'owner';
  const targets = settings.users[id]?.[maps[platform]];
  return targets && Object.hasOwn(targets, name) ? targets[name].generation : undefined;
}
const panel = (text, rows = []) => ({ text, reply_markup: { inline_keyboard: [...rows, [{ text: '⬅️ 主選單', callback_data: 'menu' }]] } });

export function exportAccountNames(settings, platform, { root, stateDir } = {}) {
  if (!Object.hasOwn(maps, platform)) return [];
  const names = new Set(Object.values(settings.users).flatMap(user => Object.keys(user[maps[platform]] || {})));
  if (root) {
    const base = path.join(root, { ig: 'instagram', x: 'x', tt: 'tiktok' }[platform]);
    try {
      if (fs.lstatSync(base).isSymbolicLink()) throw Error('EXPORT_UNSAFE_DIRECTORY');
      for (const entry of fs.readdirSync(base, { withFileTypes: true })) if (entry.isDirectory() && !entry.isSymbolicLink()) names.add(entry.name);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (platform === 'ig' && stateDir) for (const target of load(path.join(stateDir, 'health.json'), {})?.targets || []) names.add(target.username);
  return [...names].filter(name => validName(platform, name)).sort();
}

export function exportCallback(settings, id, data, updateId, now, enabled, accounts = platform => exportAccountNames(settings, platform)) {
  if (!enabled) return panel('封存匯出尚未啟用，請聯絡管理員設定 HTTPS 下載服務。');
  const [, action, platform, name] = data.split(':');
  if (action === 'platforms' && id === settings.ownerId) return panel('管理員封存匯出：先選擇平台，再選單一帳號。',
    Object.keys(maps).map(p => [{ text: { ig: 'Instagram', x: 'X', tt: 'TikTok' }[p], callback_data: `ex:owner:${p}:0` }]));
  const owner = action === 'owner' && id === settings.ownerId && Object.hasOwn(maps, platform) && /^\d{1,5}$/.test(name);
  if (owner) {
    try {
      const names = accounts(platform).filter(n => validName(platform, n));
      const page = Math.min(Number(name), Math.max(0, Math.ceil(names.length / 8) - 1));
      const rows = names.slice(page * 8, page * 8 + 8).map(n => [{ text: '@' + n, callback_data: `ex:preview:${platform}:${n}` }]);
      if (page) rows.push([{ text: '上一頁', callback_data: `ex:owner:${platform}:${page - 1}` }]);
      if ((page + 1) * 8 < names.length) rows.push([{ text: '下一頁', callback_data: `ex:owner:${platform}:${page + 1}` }]);
      return panel(names.length ? '管理員：選擇要匯出的帳號' : '尚無已知封存帳號。', rows);
    } catch { return panel('暫時無法讀取封存帳號清單，請稍後再試。'); }
  }
  const confirm = action === 'confirm' && /^[a-f0-9]{16}$/.test(platform || '');
  const account = ['preview', 'status', 'cancel'].includes(action) && exportGeneration(settings, id, platform, name);
  if (!owner && !confirm && !account) return panel('匯出選單已過期，或你目前沒有此帳號的權限。');
  const requestId = `${id}-${updateId}`;
  settings.exportRequests ||= {};
  // Bound controller storage if the export worker is unavailable.
  if (Object.values(settings.exportRequests).filter(r => r.userId === id).length >= 8) return panel('匯出服務正在處理先前操作，請稍後再試。');
  settings.exportRequests[requestId] = { id: requestId, userId: id, action, at: now,
    ...(confirm ? { preview: platform } : { platform }), ...(owner ? { page: Number(name) } : !confirm ? { name } : {}) };
  return panel(action === 'preview' ? '正在估算檔案數與大小，完成後會提供確認按鈕。' : '正在處理匯出操作，結果會傳送到此對話。');
}

export function validateExportSettings(settings) {
  if (settings.exportRequests !== undefined) {
    if (!settings.exportRequests || typeof settings.exportRequests !== 'object' || Array.isArray(settings.exportRequests)) throw Error('EXPORT_INVALID_REQUESTS');
    for (const [key, request] of Object.entries(settings.exportRequests)) {
      if (!/^\d{1,20}-\d{1,16}$/.test(key) || request?.id !== key || !/^[1-9]\d{0,19}$/.test(request.userId) || !key.startsWith(request.userId + '-') || !Number.isFinite(request.at)) throw Error('EXPORT_INVALID_REQUEST');
      if (request.action === 'confirm') {
        if (!/^[a-f0-9]{16}$/.test(request.preview)) throw Error('EXPORT_INVALID_REQUEST');
      } else if (request.action === 'owner') {
        if (!Object.hasOwn(maps, request.platform) || !Number.isInteger(request.page) || request.page < 0 || request.page > 99999) throw Error('EXPORT_INVALID_REQUEST');
      } else if (!['preview', 'status', 'cancel'].includes(request.action) || !validName(request.platform, request.name)) throw Error('EXPORT_INVALID_REQUEST');
    }
  }
  if (settings.exportReceipts !== undefined && (!settings.exportReceipts || typeof settings.exportReceipts !== 'object' || Array.isArray(settings.exportReceipts) || Object.keys(settings.exportReceipts).some(k => !/^[a-f0-9]{24}$/.test(k)))) throw Error('EXPORT_INVALID_RECEIPTS');
}

export function validExportReply(settings, reply, now = Date.now()) {
  const grant = reply.exportGrant;
  return !grant || (grant.expires * 1000 > now && exportGeneration(settings, reply.userId, grant.platform, grant.name) === grant.generation);
}

export function ingestExportReports(settings, dir, now = Date.now()) {
  const file = path.join(dir, 'reports.json');
  const health = load(path.join(dir, 'health.json'), null);
  if (!health || now - health.at > 120000) return false;
  const reports = load(file, {});
  if (!reports || Array.isArray(reports) || typeof reports !== 'object') throw Error('EXPORT_INVALID_REPORTS');
  let changed = false;
  settings.exportReceipts ||= {};
  for (const [key, report] of Object.entries(reports)) {
    if (!/^[a-f0-9]{24}$/.test(key) || typeof report?.text !== 'string' || report.text.length > 3800 || !Array.isArray(report.rows)) throw Error('EXPORT_INVALID_REPORT');
    if (settings.exportReceipts[key]) continue;
    changed = true;
    const reply = { method: 'sendMessage', userId: report.userId, at: now, exportGrant: report.grant || undefined,
      body: { chat_id: report.userId, text: report.text, link_preview_options: { is_disabled: true }, reply_markup: { inline_keyboard: report.rows } } };
    if (settings.allowedIds.includes(reply.userId) && validExportReply(settings, reply, now)) settings.replies['export:' + key] = reply;
    settings.exportReceipts[key] = true;
    if (report.requestId) delete settings.exportRequests?.[report.requestId];
  }
  for (const key of Object.keys(settings.exportReceipts)) if (!Object.hasOwn(reports, key)) { delete settings.exportReceipts[key]; changed = true; }
  return changed;
}

export function exportServiceReady(dir, now = Date.now()) {
  try { const h = JSON.parse(fs.readFileSync(path.join(dir, 'health.json'), 'utf8')); return Number.isFinite(h.at) && now - h.at < 120000; }
  catch { return false; }
}
