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
    [b('移除訂閱', `tt:remove:${name}:${gen}`)],
  ]);
}
export function tikTokCallback(user, data, now) {
  const [, action, name, kind, value, gen] = data.split(':');
  user.tiktokTargets ||= {};
  if (action === 'menu' || action === 'list') {
    delete user.waiting;
    const names = Object.keys(user.tiktokTargets).sort();
    const page = action === 'list' && /^\d{1,5}$/.test(name || '') ? Math.min(Number(name), Math.max(0, Math.ceil(names.length / 8) - 1)) : 0;
    return panel('🎬 TikTok 帳號訂閱', [...names.slice(page * 8, page * 8 + 8).map(n => [b('@' + n, 'tt:account:' + n)]),
      ...(page ? [[b('上一頁', `tt:list:${page - 1}`)]] : []), ...(names.length > (page + 1) * 8 ? [[b('下一頁', `tt:list:${page + 1}`)]] : []), [b('新增帳號', 'tt:add')]]);
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
    delete user.tiktokTargets[name]; return panel('已移除訂閱；其他人的訂閱不受影響。');
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
