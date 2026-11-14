import { platformMenu } from './platform-menu.mjs';
import { tikTokName, tikTokKinds, tikTokSubscription, tikTokLabels } from './tiktok-settings.mjs';
const b = (text, callback_data) => ({ text, callback_data });
const panel = (text, rows = []) => ({ text, reply_markup: { inline_keyboard: [...rows, [b('⬅️ TikTok', 'tt:menu'), b('主選單', 'menu')]] } });
const subFor = (u, n) => Object.hasOwn(u.tiktokTargets || {}, n) ? u.tiktokTargets[n] : undefined;
function account(user, name) {
  const sub = subFor(user, name);
  if (!sub) return panel('帳號已移除。');
  const gen = sub.generation.slice(0, 8);
  return panel(`TikTok @${name}\n關閉通知仍持續本機封存；讚好清單為選用功能。`, [
    ...tikTokKinds.map(k => [b(`${tikTokLabels[k]}：${sub.notifications[k].enabled ? '✅' : '🔕'}`, `tt:set:${name}:${k}:${sub.notifications[k].enabled ? 0 : 1}:${gen}`)]),
    [b('📦 匯出全部封存（含 LIVE）', `ex:preview:tt:${name}`)],
    [b('移除訂閱', `tt:remove:${name}:${gen}`)],
  ]);
}
export function tikTokCallback(user, data, now, overview) {
  const [, action, name, kind, value, gen] = data.split(':');
  user.tiktokTargets ||= {};
  if (action === 'menu' || action === 'list') {
    delete user.waiting;
    return platformMenu(user, 'tt', action === 'list' && /^\d{1,5}$/.test(name || '') ? Number(name) : 0, overview);
  }
  if (action === 'add') { user.waiting = 'tt:add'; return panel('請輸入 TikTok 帳號，例如 @alice。輸入 /cancel 取消。'); }
  const sub = subFor(user, name);
  if (!tikTokName(name) || !sub) return panel('帳號已移除或選單已過期。');
  if (action === 'account') return account(user, name);
  if (action === 'set' && tikTokKinds.includes(kind) && ['0', '1'].includes(value) && sub.generation.slice(0, 8) === gen) {
    if (sub.notifications[kind].enabled !== (value === '1')) sub.notifications[kind] = { enabled: value === '1', since: now };
    return account(user, name);
  }
  if (['remove', 'delete'].includes(action) && sub.generation.slice(0, 8) === kind) {
    if (action === 'remove') return panel(`移除 @${name}？正在錄製的直播會完成後再停止；保留本機檔案。`, [[b('確認移除', `tt:delete:${name}:${kind}`)]]);
    delete user.tiktokTargets[name]; return platformMenu(user, 'tt', 0, overview);
  }
  return panel('選單已過期。');
}
export function tikTokMessage(user, text, now) {
  const name = text.replace(/^\/ttadd\s+/, '').replace(/^@/, '').trim().toLowerCase();
  if (!tikTokName(name)) return panel('帳號格式不正確，請輸入 TikTok 使用者名稱。');
  user.tiktokTargets ||= {};
  if (!subFor(user, name)) Object.defineProperty(user.tiktokTargets, name, { value: tikTokSubscription(now), enumerable: true, writable: true, configurable: true });
  delete user.waiting;
  return account(user, name);
}
