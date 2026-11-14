export const platforms = {
  ig: { title: '📷 Instagram', key: 'targets', account: 'account:', add: 'add', list: 'list:', support: '支援：Story、貼文、精選；直接傳送貼文／Reel、Story 或精選連結即可下載。' },
  x: { title: '𝕏 X / Twitter', key: 'xTargets', account: 'x:account:', add: 'x:add', list: 'x:list:', support: '支援：原創、轉發、回覆、引用、歷史回補；直接傳送貼文連結即可下載。' },
  tt: { title: '🎬 TikTok', key: 'tiktokTargets', account: 'tt:account:', add: 'tt:add', list: 'tt:list:', support: '支援：貼文／照片、轉發、Story、資料變更、公開讚好（選用）、LIVE 錄影；直接傳送影片／照片連結即可下載。' },
};
export function platformMenu(user, platform, page = 0, overview) {
  const config = platforms[platform], names = Object.keys(user[config.key] || {}).sort();
  const last = Math.max(0, Math.ceil(names.length / 8) - 1);
  page = Math.min(Math.max(0, page), last);
  const selected = names.slice(page * 8, page * 8 + 8);
  const lines = selected.map(name => [overview?.accounts?.[name] || `🟡 @${name} · 等待首次檢查`, overview?.backfills?.[name]].filter(Boolean).join('\n'));
  const rows = selected.map(name => [{ text: '@' + name, callback_data: config.account + name }]);
  if (last) rows.push([...(page ? [{ text: '上一頁', callback_data: config.list + (page - 1) }] : []), ...(page < last ? [{ text: '下一頁', callback_data: config.list + (page + 1) }] : [])]);
  rows.push([{ text: '➕ 新增帳號', callback_data: config.add }, { text: '🔄 重新整理', callback_data: config.list + page }], [{ text: '⬅️ 主選單', callback_data: 'menu' }]);
  return { text: [`${config.title}｜監看 ${names.length} 個帳號`, config.support, '', ...(lines.length ? lines : ['尚未新增帳號。']), ...(last ? [`第 ${page + 1}/${last + 1} 頁`] : [])].join('\n'), reply_markup: { inline_keyboard: rows } };
}
