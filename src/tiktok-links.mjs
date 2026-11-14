export const tikTokLinkPattern = /(?:https?:\/\/)?(?:(?:www|vm|vt)\.)?tiktok\.com\/[^\s<>"']+/gi;
export function parseTikTokLink(raw) {
  const u = new URL(/^https?:\/\//i.test(raw) ? raw : 'https://' + raw);
  if (u.protocol !== 'https:' || u.username || u.password || u.port || !['tiktok.com','www.tiktok.com','vm.tiktok.com','vt.tiktok.com'].includes(u.hostname)) throw Error('TIKTOK_INVALID_LINK');
  if (!/^\/@[a-zA-Z0-9_][a-zA-Z0-9_.]{0,23}\/(?:video|photo)\/\d{1,30}\/?$/.test(u.pathname) && !(['vm.tiktok.com','vt.tiktok.com'].includes(u.hostname) && /^\/[A-Za-z0-9]+\/?$/.test(u.pathname)) && !/^\/t\/[A-Za-z0-9]+\/?$/.test(u.pathname)) throw Error('TIKTOK_INVALID_LINK');
  return u.origin + u.pathname;
}
