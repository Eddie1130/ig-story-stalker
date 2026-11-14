import { platformMenu } from './platform-menu.mjs';
import { tikTokLinkPattern, parseTikTokLink } from './tiktok-links.mjs';
import { tikTokCallback, tikTokMessage } from './tiktok-menu.mjs';
import { instagramLinks } from './instagram-links.mjs';
import { kinds, validUsername, userTarget, put } from './telegram-settings.mjs';
import { subscription } from './telegram-settings.mjs';
import { xCallback, xMessage, xLinkPattern, hasInstagramLinks, combinePanels } from './x-menu.mjs';
import { exportCallback } from './archive-export.mjs';

const labels = { story: 'Story', post: '貼文', highlight: '精選' };
const button = (text, callback_data) => ({ text, callback_data });
const panel = (text, rows) => ({ text, reply_markup: { inline_keyboard: rows } });
const back = [button('⬅️ 主選單', 'menu')];
export function mainMenu(user) {
  return panel('Instagram／X／TikTok 監看設定\n直接傳送支援的內容連結即可下載。', [
    [button('📷 Instagram', 'ig:menu'), button('𝕏 X / Twitter', 'x:menu')],
    [button('🎬 TikTok', 'tt:menu')],
    [button('🔔 通知', 'notifications'), button('📊 狀態', 'status')],
  ]);
}
function notificationMenu(user) {
  return panel('🔔 我的全域通知設定\n只影響你的 Telegram；各帳號細項設定會保留，本機下載持續進行。\n異常仍會通知，恢復後自動清除。', [
    [button(`媒體通知：${user.mediaNotifications === false ? '🔕 關閉' : '✅ 開啟'}`, `media:${user.mediaNotifications === false ? 1 : 0}`)],
    [button(`每日摘要：${user.daily ? '✅ 開啟' : '🔕 關閉'}`, `daily:${user.daily ? 0 : 1}`)], back,
  ]);
}

function accountMenu(user, name) {
  const sub = userTarget(user, name);
  if (!sub) return panel('此帳號已不在你的清單中。', [back]);
  const gen = sub.generation.slice(0, 8);
  return panel(`@${name}\n個人通知設定（本機下載持續進行）`, [
    ...kinds.map(kind => [button(`${labels[kind]}：${sub.notifications[kind].enabled ? '✅ 開啟' : '🔕 關閉'}`, `set:${name}:${kind}:${sub.notifications[kind].enabled ? 0 : 1}:${gen}`)]),
    [button('📦 匯出全部封存', `ex:preview:ig:${name}`)],
    [button('🗑 移除監看', `remove:${name}:${gen}`)],
    [button('⬅️ 帳號清單', 'list:0')], back,
  ]);
}
function listMenu(user, page = 0, overview) { return platformMenu(user, 'ig', page, overview); }

// Mutate settings and enqueue replies in one durable transaction with the update offset.
// Desired values and subscription generations make repeated/stale buttons harmless.
export function applyUpdate(settings, update, now = Date.now(), statusText = () => '狀態暫時無法取得。', exportEnabled = false, exportAccounts) {
  if (!Number.isSafeInteger(update?.update_id) || update.update_id < settings.offset) return false;
  const callback = update.callback_query;
  const message = callback?.message || update.message;
  const from = callback?.from || message?.from;
  const id = String(from?.id || '');
  settings.offset = update.update_id + 1;
  if (from?.is_bot || message?.chat?.type !== 'private' || String(message.chat.id) !== id || !settings.allowedIds.includes(id)) return true;
  const user = settings.users[id];
  if (!user) return true;
  const inputMessageId = user.waitingMessageId;
  const overview = platform => statusText.platform?.(id, platform);
  let result;
  if (callback) {
    delete user.waiting; delete user.waitingMessageId;
    settings.replies[`ack:${update.update_id}`] = { method: 'answerCallbackQuery', body: { callback_query_id: callback.id }, userId: id, at: now };
    const parts = String(callback.data || '').split(':');
    const [action, name, kind, value, generation] = parts;
    if (action === 'ex') result = exportCallback(settings, id, callback.data, update.update_id, now, exportEnabled, exportAccounts);
    else if (action === 'tt') result = tikTokCallback(user, callback.data, now, overview('tt'));
    else if (action === 'x') result = xCallback(settings, user, id, callback.data, update.update_id, now, overview('x'));
    else if (action === 'menu') { delete user.waiting; result = mainMenu(user); }
    else if (action === 'ig' && name === 'menu') { delete user.waiting; result = listMenu(user, 0, overview('ig')); }
    else if (action === 'notifications') result = notificationMenu(user);
    else if (action === 'media' && ['0', '1'].includes(name)) {
      const enabled = name === '1';
      if (enabled && user.mediaNotifications === false) user.mediaNotificationsSince = now;
      user.mediaNotifications = enabled;
      result = notificationMenu(user);
    }
    else if (action === 'list' && /^\d{1,5}$/.test(name)) result = listMenu(user, Number(name), overview('ig'));
    else if (action === 'account' && validUsername(name)) result = accountMenu(user, name);
    else if (action === 'add') { user.waiting = 'add'; result = panel('請傳送要監看的 Instagram 使用者名稱，例如 alice 或 @alice。\n輸入 /cancel 可取消。', [back]); }
    else if (action === 'daily' && ['0', '1'].includes(name)) {
      user.daily = name === '1';
      result = notificationMenu(user);
    } else if (action === 'download') {
      delete user.waiting;
      result = panel('直接貼上 Instagram、X 或 TikTok 貼文連結即可下載。\n每則訊息最多 10 個連結；貼上帳號首頁會先詢問是否加入監看。', [back]);
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
      else { delete user.targets[name]; result = listMenu(user, 0, overview('ig')); }
    } else result = panel('此選單已過期，請重新選擇。', [back]);
  } else {
    const text = String(message.text || message.caption || '').trim();
    const linkedText = [text, ...(message.entities || message.caption_entities || []).filter(e => e.type === 'text_link' && typeof e.url === 'string').map(e => e.url)].join(' ');
    const totalLinks = (linkedText.match(/(?:https?:\/\/[^\s<>"']+|(?:(?:www|mobile|m|vm|vt)\.)?(?:instagram|x|twitter|fxtwitter|tiktok)\.com\/[^\s<>"']+)/gi) || []).length;
    const ttLinks = totalLinks <= 10 ? (linkedText.match(tikTokLinkPattern) || []) : [];
    let ttResult;
    if (ttLinks.length) {
      let count = 0;
      for (const [i, raw] of ttLinks.entries()) {
        try {
          const url = parseTikTokLink(raw.replace(/[),\]，。！!]+$/, ''));
          const requestId = `${id}-${update.update_id}-${i}`;
          settings.tiktokRequests ||= {};
          settings.tiktokRequests[requestId] = { id: requestId, userId: id, url, at: now };
          count++;
        } catch {}
      }
      ttResult = panel(`已加入 ${count} 個 TikTok 連結到下載佇列。${count < ttLinks.length ? '部分連結格式不支援。' : '完成後會回傳媒體。'}`, [back]);
    }
    const xResult = totalLinks > 10 || /^\/(start|menu|cancel)(?:@[A-Za-z0-9_]+)?$/.test(text) ? undefined : xMessage(settings, user, id, text, linkedText, update.update_id, now);
    if (totalLinks > 10) result = panel('每則訊息最多 10 個連結，請分批傳送。', [back]);
    else if (/^\/(start|menu|cancel)(?:@[A-Za-z0-9_]+)?$/.test(text)) { delete user.waiting; result = mainMenu(user); }
    else if (/^\/status$/.test(text)) result = panel(statusText(id), [[button('🔄 重新整理', 'status')], back]);
    else if (user.waiting === 'tt:add' || /^\/ttadd\s+/.test(text)) result = tikTokMessage(user, text, now);
    else if (ttResult && !xResult && !hasInstagramLinks(linkedText)) result = ttResult;
    else if (xResult && !hasInstagramLinks(linkedText)) result = xResult;
    else if (/https?:\/\/|(?:^|\s)(?:www\.|m\.)?instagram\.com\//i.test(linkedText)) {
      try {
        const links = instagramLinks((xResult ? linkedText.replace(xLinkPattern, '') : linkedText).replace(tikTokLinkPattern, ''));
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
    if (ttResult && result !== ttResult) result = combinePanels(result, ttResult);
    if (xResult && hasInstagramLinks(linkedText)) result = combinePanels(result, xResult);
  }
  if (exportEnabled && id === settings.ownerId && result?.text?.startsWith('🔔 我的全域通知設定')) result.reply_markup.inline_keyboard.push([button('📦 管理員封存匯出', 'ex:platforms')]);
  const messageId = callback?.message?.message_id || inputMessageId;
  if (user.waiting && Number.isSafeInteger(messageId) && messageId > 0) user.waitingMessageId = messageId;
  else delete user.waitingMessageId;
  settings.replies[`reply:${update.update_id}`] = {
    method: Number.isSafeInteger(messageId) && messageId > 0 ? 'editMessageText' : 'sendMessage',
    body: { chat_id: id, ...(Number.isSafeInteger(messageId) && messageId > 0 ? { message_id: messageId } : {}), ...result }, userId: id, at: now, ...(user.waiting ? { inputPrompt: user.waiting } : {}),
  };
  return true;
}
