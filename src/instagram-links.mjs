const hosts = new Set(['instagram.com', 'www.instagram.com', 'm.instagram.com']);
const reserved = new Set(['accounts', 'explore', 'direct', 'api', 'graphql', 'stories', 'reels', 'p', 'reel', 'tv', 'share', 'about', 'developer', 'legal']);
export function parseInstagramLink(input) {
  let url;
  try { url = new URL(/^https?:\/\//i.test(input) ? input : 'https://' + input); } catch { throw Error('MANUAL_INVALID_LINK'); }
  if (!hosts.has(url.hostname.toLowerCase()) || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || (url.port && url.port !== '443') || /%|\\/.test(url.pathname)) throw Error('MANUAL_INVALID_LINK');
  const parts = url.pathname.split('/').filter(Boolean);
  const name = value => typeof value === 'string' && /^[a-z0-9_.]{1,30}$/i.test(value) && !['.', '..'].includes(value);
  const numeric = value => /^\d{1,30}$/.test(value || '');
  let spec;
  if (parts.length === 2 && ['p', 'reel', 'tv'].includes(parts[0]) && /^[A-Za-z0-9_-]{1,32}$/.test(parts[1])) {
    spec = { kind: 'post', shortcode: parts[1], identity: 'post:' + parts[1], path: `/${parts[0]}/${parts[1]}/` };
  } else if (parts.length === 3 && parts[0] === 'stories' && parts[1] === 'highlights' && numeric(parts[2])) {
    spec = { kind: 'highlight', contentId: parts[2], identity: 'highlight:' + parts[2], path: `/stories/highlights/${parts[2]}/` };
  } else if (parts.length === 3 && parts[0] === 'stories' && name(parts[1]) && numeric(parts[2])) {
    spec = { kind: 'story', username: parts[1].toLowerCase(), contentId: parts[2], identity: 'story:' + parts[2], path: `/stories/${parts[1].toLowerCase()}/${parts[2]}/` };
  } else if (parts[0] === 'share' && parts.length >= 2 && parts.length <= 3 && parts.slice(1).every(p => /^[A-Za-z0-9_-]{1,128}$/.test(p))) {
    spec = { kind: 'share', identity: 'share:' + parts.slice(1).join(':'), path: '/' + parts.join('/') + '/' };
  } else if (parts.length === 1 && name(parts[0]) && !reserved.has(parts[0].toLowerCase())) {
    spec = { kind: 'profile', username: parts[0].toLowerCase(), path: '/' + parts[0].toLowerCase() + '/' };
  } else throw Error('MANUAL_UNSUPPORTED_LINK');
  return { ...spec, url: 'https://www.instagram.com' + spec.path };
}
export function instagramLinks(text) {
  const candidates = String(text).match(/(?:https?:\/\/[^\s<>"']+|(?:www\.|m\.)?instagram\.com\/[^\s<>"']+)/gi) || [];
  if (!candidates.length) return [];
  if (candidates.length > 10) throw Error('MANUAL_TOO_MANY_LINKS');
  return candidates.map((raw, index) => {
    try { return parseInstagramLink(raw.replace(/[),\]，。！!]+$/, '')); }
    catch (error) { return { kind: 'invalid', index: index + 1, reason: error.message }; }
  });
}
export function shortcodeId(code) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(code)) throw Error('MANUAL_INVALID_SHORTCODE');
  let id = 0n;
  for (const char of code) id = id * 64n + BigInt(alphabet.indexOf(char));
  if (id <= 0n || id.toString().length > 30) throw Error('MANUAL_INVALID_SHORTCODE');
  return id.toString();
}
export const manualJobId = value => typeof value === 'string' && /^\d{1,20}-\d{1,16}-\d{1,2}$/.test(value);
