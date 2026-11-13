import { validXUsername, xKinds, xLinks } from './x-model.mjs';
import { xSubscription, xTarget, putXTarget, validXDate } from './x-settings.mjs';

const labels = { post: '原創', repost: '轉發', reply: '回覆', quote: '引用' };
const button = (text, callback_data) => ({ text, callback_data });
const panel = (text, rows = []) => ({ text, reply_markup: { inline_keyboard: rows } });
const back = [button('⬅️ X 選單', 'x:menu')];
export const xLinkPattern = /(?:https?:\/\/)?(?:(?:www|mobile|m)\.)?(?:x|twitter|fxtwitter)\.com\/[^\s<>"']+/gi;
export const hasInstagramLinks = text => /(?:https?:\/\/)?(?:www\.|m\.)?instagram\.com\//i.test(text);

export function xMainMenu(user) {
  return panel('X 監看設定\n第一次輪詢只封存並建立基準，之後的新內容才通知。\n通知關閉時仍持續封存。', [
    [button('👥 X 監看帳號', 'x:list:0'), button('➕ 新增 X 帳號', 'x:add')],
    [button('🔗 X 連結下載', 'x:download'), button('📊 我的狀態', 'status')],
    [button('📷 Instagram', 'ig:menu'), button('⬅️ 平台選單', 'menu')],
  ]);
}
function xAccountMenu(user, name) {
  const sub = xTarget(user, name);
  if (!sub) return panel('此 X 帳號已不在你的清單中。', [back]);
  const gen = sub.generation.slice(0, 8);
  return panel(`X @${name}\n通知設定只影響你自己的 Telegram；本機封存持續進行。`, [
    ...xKinds.map(kind => [button(`${labels[kind]}：${sub.notifications[kind].enabled ? '✅ 開啟' : '🔕 關閉'}`, `x:set:${name}:${kind}:${sub.notifications[kind].enabled ? 0 : 1}:${gen}`)]),
    [button('🗂 一鍵歷史回補', `x:history:${name}:${gen}`)],
    [button('📅 指定回補日期', `x:dates:${name}:${gen}`)],
    [button('🗑 移除監看', `x:remove:${name}:${gen}`)],
    [button('⬅️ X 帳號清單', 'x:list:0')], back,
  ]);
}
function xListMenu(user, page = 0) {
  const names = Object.keys(user.xTargets || {}).sort(), last = Math.max(0, Math.ceil(names.length / 8) - 1);
  page = Math.min(Math.max(0, page), last);
  const rows = names.slice(page * 8, page * 8 + 8).map(name => [button('@' + name, 'x:account:' + name)]);
  if (last) rows.push([...(page ? [button('上一頁', 'x:list:' + (page - 1))] : []), ...(page < last ? [button('下一頁', 'x:list:' + (page + 1))] : [])]);
  return panel(names.length ? `你的 X 監看帳號（${page + 1}/${last + 1}）` : '尚未加入 X 帳號。', [...rows, [button('➕ 新增 X 帳號', 'x:add')], back]);
}
function addTarget(user, raw, now) {
  const name = raw.trim().replace(/^@/, '').toLowerCase();
  if (!validXUsername(name)) return panel('X 使用者名稱格式不正確，請只輸入 1–15 個英文字母、數字或底線。', [back]);
  if (!xTarget(user, name)) putXTarget(user, name, xSubscription(now));
  delete user.waiting;
  return xAccountMenu(user, name);
}
function history(settings, user, id, updateId, name, now, start, end) {
  if (!validXUsername(name) || !xTarget(user, name)) return panel('請先將此 X 帳號加入你自己的監看清單。', [back]);
  if ((start !== undefined || end !== undefined) && (!validXDate(start) || !validXDate(end) || start >= end))
    return panel('日期格式不正確。請使用 /xhistory 帳號 YYYY-MM-DD YYYY-MM-DD；結束日期不包含當天。', [back]);
  if ((start && start > new Date(now).toISOString().slice(0, 10)) ||
      (end && end > new Date(now + 86400000).toISOString().slice(0, 10)))
    return panel('歷史回補日期不能超過申請當天；結束日期最多填 UTC 明天（不含當天）。', [back]);
  const requestId = `${id}-${updateId}-0`;
  settings.xRequests ||= {};
  settings.xRequests[requestId] = { id: requestId, userId: id, type: 'history', username: name, at: now, ...(start ? { start, end } : {}) };
  delete user.waiting;
  return panel(`已申請 @${name} 的歷史回補。\n${start ? `${start} 至 ${end}（不含結束當天）` : '自動從帳號建立日抓到啟動當天。'}\n同一目標共用任務，其他回補會排隊；只通知進度與結果。\n可按「我的狀態」查看進度。`, [back]);
}
export function xCallback(settings, user, id, data, updateId, now) {
  const [prefix, action, name, kind, value, generation] = String(data).split(':');
  if (prefix !== 'x') return;
  if (action === 'menu') { delete user.waiting; return xMainMenu(user); }
  if (action === 'list' && /^\d{1,5}$/.test(name)) return xListMenu(user, Number(name));
  if (action === 'add') { user.waiting = 'x:add'; return panel('請傳送 X 使用者名稱，例如 alice 或 @alice。\n輸入 /cancel 可取消。', [back]); }
  if (action === 'download') { delete user.waiting; return panel('貼上 x.com、twitter.com 或 fxtwitter.com 的單篇貼文連結，即可下載文字與媒體。\n貼上帳號首頁會先詢問是否訂閱。', [back]); }
  if (action === 'follow' && validXUsername(name)) return addTarget(user, name, now);
  if (action === 'account' && validXUsername(name)) return xAccountMenu(user, name);
  const sub = validXUsername(name) && xTarget(user, name);
  if (action === 'set' && sub && xKinds.includes(kind) && ['0', '1'].includes(value) && sub.generation.slice(0, 8) === generation) {
    const pref = sub.notifications[kind];
    if (pref.enabled !== (value === '1')) { pref.enabled = value === '1'; pref.since = now; }
    return xAccountMenu(user, name);
  }
  if (['remove', 'delete', 'history', 'dates'].includes(action) && sub?.generation.slice(0, 8) === kind) {
    if (action === 'history') return history(settings, user, id, updateId, name, now);
    if (action === 'dates') return panel(`請傳送：\n/xhistory ${name} YYYY-MM-DD YYYY-MM-DD\n例如 /xhistory ${name} 2024-01-01 2025-01-01\n結束日期不包含當天。`, [back]);
    if (action === 'remove') return panel(`要移除 X @${name} 嗎？\n保留本機檔案及歷史；其他使用者的訂閱不受影響。`, [[button('確認移除', `x:delete:${name}:${kind}`)], [button('取消', 'x:account:' + name)]]);
    delete user.xTargets[name]; return xListMenu(user);
  }
  return panel('此 X 選單已過期，請重新選擇。', [back]);
}
export function xMessage(settings, user, id, text, linkedText, updateId, now) {
  if (/^\/xadd(?:@[A-Za-z0-9_]+)?(?:\s|$)/i.test(text)) {
    const raw = text.replace(/^\/xadd(?:@[A-Za-z0-9_]+)?\s*/i, '');
    if (!raw) { user.waiting = 'x:add'; return panel('請傳送要監看的 X 使用者名稱。', [back]); }
    return addTarget(user, raw, now);
  }
  if (/^\/xhistory(?:@[A-Za-z0-9_]+)?(?:\s|$)/i.test(text)) {
    const args = text.replace(/^\/xhistory(?:@[A-Za-z0-9_]+)?\s*/i, '').split(/\s+/);
    if (![1, 3].includes(args.length)) return panel('請使用 /xhistory 帳號，或 /xhistory 帳號 YYYY-MM-DD YYYY-MM-DD。', [back]);
    return history(settings, user, id, updateId, args[0].replace(/^@/, '').toLowerCase(), now, args[1], args[2]);
  }
  const candidates = linkedText.match(xLinkPattern) || [];
  if (candidates.length) {
    try {
      if (candidates.length > 10) throw Error('X_TOO_MANY_LINKS');
      const links = candidates.map(raw => {
        try { return xLinks(/^https?:\/\//i.test(raw) ? raw : 'https://' + raw)[0] || { kind: 'invalid' }; }
        catch { return { kind: 'invalid' }; }
      });
      const profiles = links.filter(link => link.kind === 'profile'), posts = links.filter(link => link.kind === 'post');
      const invalid = links.filter(link => !['profile', 'post'].includes(link.kind));
      settings.xRequests ||= {};
      for (let i = 0; i < posts.length; i++) {
        const requestId = `${id}-${updateId}-${i}`;
        settings.xRequests[requestId] = { id: requestId, userId: id, type: 'manual', username: posts[i].username, url: posts[i].url, at: now };
      }
      delete user.waiting;
      return panel([posts.length ? `已加入 ${posts.length} 個 X 連結到下載佇列，完成後回傳文字及媒體。` : '',
        ...profiles.map(link => `是否將 X @${link.username} 加入你的監看清單？`),
        invalid.length ? `${invalid.length} 個 X 連結不支援，請確認網址。` : ''].filter(Boolean).join('\n') || 'X 連結無法辨識。',
      [...profiles.map(link => [button(`加入 X @${link.username}`, 'x:follow:' + link.username)]), back]);
    } catch { return panel('X 連結無法辨識，或超過每則訊息 10 個連結的限制。', [back]); }
  }
  if (user.waiting === 'x:add' && !text.startsWith('/')) return addTarget(user, text, now);
}

export function combinePanels(first, second) {
  return panel([first.text, second.text].join('\n\n'), [...(first.reply_markup?.inline_keyboard || []), ...(second.reply_markup?.inline_keyboard || [])]);
}
