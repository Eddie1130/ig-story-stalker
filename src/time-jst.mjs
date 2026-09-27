
export function formatJST(ms = Date.now()) {
  const d = new Date(Number(ms) + 9 * 60 * 60 * 1000);
  return Number.isFinite(d.getTime())
    ? d.toISOString().slice(0, 19).replace('T', ' ') + ' JST'
    : '未知';
}
