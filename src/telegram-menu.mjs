import { tikTokCallback, tikTokMessage } from './tiktok-menu.mjs';
import { instagramLinks } from './instagram-links.mjs';
import { kinds, validUsername, userTarget, put } from './telegram-settings.mjs';
import { subscription } from './telegram-settings.mjs';
import { xCallback, xMessage, xLinkPattern, hasInstagramLinks, combinePanels } from './x-menu.mjs';

const labels = { story: 'Story', post: '貼文', highlight: '精選' };
const button = (text, callback_data) => ({ text, callback_data });
const panel = (text, rows) => ({ text, reply_markup: { inline_keyboard: rows } });
const back = [button('⬅️ 主選單', 'menu')];
export function mainMenu(user) {
  return panel('Instagram／X／TikTok 監看設定\n通知開關只影響 Telegram，本機仍會下載。', [
    [button('📷 Instagram', 'ig:menu'), button('𝕏 X / Twitter', 'x:menu')],
    [button('👥 監看帳號', 'list:0'), button('➕ 新增帳號', 'add')],
    [button('🎬 TikTok', 'tt:menu')],
    [button('🔔 媒體通知', 'list:0')],
    [button(`📋 每日摘要：${user.daily ? '開啟' : '關閉'}`, `daily:${user.daily ? 0 : 1}`)],
    [button('🔗 連結下載', 'download')],
    [button('📊 我的狀態', 'status')],
  ]);
}
function accountMenu(user, name) {
  const sub = userTarget(user, name);
  if (!sub) return panel('此帳號已不在你的清單中。', [back]);
  const gen = sub.generation.slice(0, 8);
  return panel(`@${name}\n個人通知設定（本機下載持續進行）`, [
    ...kinds.map(kind => [button(`${labels[kind]}：${sub.notifications[kind].enabled ? '✅ 開啟' : '🔕 關閉'}`, `set:${name}:${kind}:${sub.notifications[kind].enabled ? 0 : 1}:${gen}`)]),
    [button('🗑 移除監看', `remove:${name}:${gen}`)],
    [button('⬅️ 帳號清單', 'list:0')], back,
  ]);
}
function listMenu(user, page = 0) {
  const names = Object.keys(user.targets).sort(), last = Math.max(0, Math.ceil(names.length / 8) - 1);
  page = Math.min(Math.max(0, page), last);
  const rows = names.slice(page * 8, page * 8 + 8).map(name => [button('@' + name, 'account:' + name)]);
  if (last) rows.push([...(page ? [button('上一頁', 'list:' + (page - 1))] : []), ...(page < last ? [button('下一頁', 'list:' + (page + 1))] : [])]);
  return panel(names.length ? `你的監看帳號（${page + 1}/${last + 1}）\n點選帳號設定通知或移除。` : '尚未加入任何帳號。', [...rows, [button('➕ 新增帳號', 'add')], back]);
}

// Mutate settings and enqueue replies in one durable transaction with the update offset.
// Desired values and subscription generations make repeated/stale buttons harmless.
export function applyUpdate(settings, update, now = Date.now(), statusText = () => '狀態暫時無法取得。') {
  if (!Number.isSafeInteger(update?.update_id) || update.update_id < settings.offset) return false;
  const callback = update.callback_query;
  const message = callback?.message || update.message;
  const from = callback?.from || message?.from;
  const id = String(from?.id || '');
  settings.offset = update.update_id + 1;
  if (from?.is_bot || message?.chat?.type !== 'private' || String(message.chat.id) !== id || !settings.allowedIds.includes(id)) return true;
  const user = settings.users[id];
  if (!user) return true;
  let result;
  if (callback) {
    settings.replies[`ack:${update.update_id}`] = { method: 'answerCallbackQuery', body: { callback_query_id: callback.id }, userId: id, at: now };
    const parts = String(callback.data || '').split(':');
    const [action, name, kind, value, generation] = parts;
    if (action === 'tt') result = tikTokCallback(user, callback.data, now);
    else if (action === 'x') result = xCallback(settings, user, id, callback.data, update.update_id, now);
    else if (action === 'menu' || (action === 'ig' && name === 'menu')) { delete user.waiting; result = mainMenu(user); }
    else if (action === 'list' && /^\d{1,5}$/.test(name)) result = listMenu(user, Number(name));
    else if (action === 'account' && validUsername(name)) result = accountMenu(user, name);
    else if (action === 'add') { user.waiting = 'add'; result = panel('請傳送要監看的 Instagram 使用者名稱，例如 alice 或 @alice。\n輸入 /cancel 可取消。', [back]); }
    else if (action === 'daily' && ['0', '1'].includes(name)) {
      user.daily = name === '1';
      result = panel(`每日摘要已${user.daily ? '開啟，每天香港時間 20:00 發送。' : '關閉。'}\n異常與恢復通知仍會發送。`, [back]);
    } else if (action === 'download') {
      delete user.waiting;
      result = panel('直接貼上 Instagram 貼文、Reel、Story 或精選連結即可下載。\n每則訊息最多 10 個連結；貼上帳號首頁會先詢問是否加入監看。', [back]);
    } else if (action === 'follow' && validUsername(name)) {
      if (!userTarget(user, name)) put(user.targets, name, subscription(now));
      result = accountMenu(user, name);
    } else if (action === 'status') result = panel(statusText(id), [[button('🔄 重新整理', 'status')], back]);
    else if (action === 'set' && validUsername(name) && kinds.includes(kind) && ['0', '1'].includes(value) && userTarget(user, name)?.generation.slice(0, 8) === generation) {
      const preference = userTarget(user, name).notifications[kind];
      if (preference.enabled !== (value === '1')) { preference.enabled = value === '1'; preference.since = now; }
      result = accountMenu(user, name);
    } else if (['remove', 'delete'].includes(action) && validUsername(name) && userTarget(user, name)?.generation.slice(0, 8) === kind) {
      if (action === 'remove') result = panel(`要從你的清單移除 @${name} 嗎？\n保留本機檔案及歷史紀錄；其他使用者的監看不受影響。`, [[button('確認移除', `delete:${name}:${kind}`)], [button('取消', 'account:' + name)]]);
      else { delete user.targets[name]; result = listMenu(user); }
    } else result = panel('此選單已過期，請重新選擇。', [back]);
  } else {
    const text = String(message.text || message.caption || '').trim();
    const linkedText = [text, ...(message.entities || message.caption_entities || []).filter(e => e.type === 'text_link' && typeof e.url === 'string').map(e => e.url)].join(' ');
    const totalLinks = (linkedText.match(/(?:https?:\/\/[^\s<>"']+|(?:(?:www|mobile|m)\.)?(?:instagram|x|twitter|fxtwitter)\.com\/[^\s<>"']+)/gi) || []).length;
    const xResult = totalLinks > 10 || /^\/(start|menu|cancel)(?:@[A-Za-z0-9_]+)?$/.test(text) ? undefined : xMessage(settings, user, id, text, linkedText, update.update_id, now);
    if (totalLinks > 10) result = panel('每則訊息最多 10 個連結，請分批傳送。', [back]);
    else if (/^\/(start|menu|cancel)(?:@[A-Za-z0-9_]+)?$/.test(text)) { delete user.waiting; result = mainMenu(user); }
    else if (/^\/status$/.test(text)) result = panel(statusText(id), [[button('🔄 重新整理', 'status')], back]);
    else if (user.waiting === 'tt:add' || /^\/ttadd\s+/.test(text)) result = tikTokMessage(user, text, now);
    else if (xResult && !hasInstagramLinks(linkedText)) result = xResult;
    else if (/https?:\/\/|(?:^|\s)(?:www\.|m\.)?instagram\.com\//i.test(linkedText)) {
      try {
        const links = instagramLinks(xResult ? linkedText.replace(xLinkPattern, '') : linkedText);
        if (!links.length) throw Error('MANUAL_INVALID_LINK');
        const profiles = links.filter(link => link.kind === 'profile');
        const content = links.filter(link => !['profile','invalid'].includes(link.kind));
        const invalid = links.filter(link => link.kind === 'invalid');
        settings.manualRequests ||= {};
        for (let i = 0; i < content.length; i++) {
          const jobId = `${id}-${update.update_id}-${i}`;
          settings.manualRequests[jobId] = { id: jobId, userId: id, url: content[i].url, at: now };
        }
        delete user.waiting;
        result = panel([content.length ? `已加入 ${content.length} 個連結到下載佇列。完成後會回傳媒體，並保留本機原檔。` : '',
          ...invalid.map(link => `第 ${link.index} 個連結不支援，請確認網址。`),
          ...profiles.map(link => `是否將 @${link.username} 加入你的監看清單？`)].filter(Boolean).join('\n'),
          [...profiles.map(link => [button(`加入 @${link.username}`, 'follow:' + link.username)]), ...(profiles.length ? [[button('取消', 'menu')]] : []), back]);
      } catch (error) {
        result = panel(error.message === 'MANUAL_TOO_MANY_LINKS' ? '每則訊息最多 10 個連結，請分批傳送。' : '目前只接受 Instagram 貼文、Reel、Story、精選或帳號首頁連結，請確認網址。', [back]);
      }
    }
    else if (user.waiting === 'add' || /^\/add\s+/.test(text)) {
      const name = text.replace(/^\/add\s+/, '').replace(/^@/, '').trim().toLowerCase();
      if (!validUsername(name)) result = panel('使用者名稱格式不正確，請只輸入帳號名稱。', [back]);
      else {
        const existing = !!userTarget(user, name);
        if (!existing) put(user.targets, name, subscription(now));
        delete user.waiting;
        result = panel(`${existing ? '已在你的清單中' : '已加入監看'}：@${name}\n目前可取得的 Story 會依設定通知；舊貼文與精選只下載。\n若帳號不存在或無法存取，會顯示異常通知。`, [[button('設定通知', 'account:' + name)], back]);
      }
    } else result = mainMenu(user);
    if (xResult && hasInstagramLinks(linkedText)) result = combinePanels(result, xResult);
  }
  settings.replies[`reply:${update.update_id}`] = { method: 'sendMessage', body: { chat_id: id, ...result }, userId: id, at: now };
  return true;
}
