import { validExportReply } from './archive-export.mjs';

export async function flushReplies(settingsSource, client, persist, { stopping = () => false, log = () => {} } = {}) {
  const current = typeof settingsSource === 'function' ? settingsSource : () => settingsSource;
  let ok = true;
  for (const key of Object.keys(current().replies)) {
    let settings = current(), reply = settings.replies[key];
    if (stopping()) break;
    if (!reply) continue;
    if (!settings.allowedIds.includes(reply.userId) || !validExportReply(settings, reply)) { delete settings.replies[key]; persist(); continue; }
    if (!['sendMessage', 'answerCallbackQuery'].includes(reply.method) || (reply.method === 'sendMessage' && String(reply.body?.chat_id) !== reply.userId)) throw Error('TELEGRAM_REPLY_INVALID');
    if (Date.now() < (reply.retryAt || 0)) { ok = false; continue; }
    try { await client.call(reply.method, reply.body); }
    catch (error) {
      if (!/^TELEGRAM_(?:ERROR_\d+|NETWORK_OR_RESPONSE_ERROR|RETRY_WAIT|STOPPING)$/.test(error.message)) throw error;
      if (reply.method === 'answerCallbackQuery' && error.message === 'TELEGRAM_ERROR_400') {
        // Expired acknowledgements cannot be retried; the menu response is separate.
      } else {
        settings = current(); reply = settings.replies[key];
        if (!reply) continue;
        reply.failures = (reply.failures || 0) + 1;
        reply.retryAt = Date.now() + Math.min(300, 15 * 2 ** Math.min(reply.failures, 5)) * 1000;
        reply.error = error.message; persist(); ok = false;
        log('TELEGRAM_REPLY_RETRY', { userId: reply.userId, reason: error.message });
        continue;
      }
    }
    delete current().replies[key]; persist();
  }
  return ok;
}
