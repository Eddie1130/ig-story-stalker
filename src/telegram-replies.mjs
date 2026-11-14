import { validExportReply } from './archive-export.mjs';

export async function flushReplies(settingsSource, client, persist, { stopping = () => false, log = () => {} } = {}) {
  const current = typeof settingsSource === 'function' ? settingsSource : () => settingsSource;
  let ok = true;
  for (const key of Object.keys(current().replies)) {
    let settings = current(), reply = settings.replies[key];
    if (stopping()) break;
    if (!reply) continue;
    if (!settings.allowedIds.includes(reply.userId) || !validExportReply(settings, reply)) { delete settings.replies[key]; persist(); continue; }
    if (!['sendMessage', 'editMessageText', 'answerCallbackQuery'].includes(reply.method) || (reply.method !== 'answerCallbackQuery' && String(reply.body?.chat_id) !== reply.userId)) throw Error('TELEGRAM_REPLY_INVALID');
    if (reply.method === 'editMessageText' && (!Number.isSafeInteger(reply.body.message_id) || reply.body.message_id < 1)) throw Error('TELEGRAM_REPLY_INVALID');
    // A newer click supersedes unsent edits for the same menu message.
    const queued = Object.entries(current().replies);
    const targetMessageId = reply.body.message_id || reply.replacesMessageId;
    const newer = queued.slice(queued.findIndex(([id]) => id === key) + 1).some(([, other]) =>
      other.userId === reply.userId && (other.body.message_id || other.replacesMessageId) === targetMessageId && ['editMessageText', 'sendMessage'].includes(other.method));
    if (targetMessageId && newer) { delete current().replies[key]; persist(); continue; }
    if (Date.now() < (reply.retryAt || 0)) { ok = false; continue; }
    try {
      const result = await client.call(reply.method, reply.body);
      if (reply.inputPrompt && reply.method === 'sendMessage' && current().users?.[reply.userId]?.waiting === reply.inputPrompt && Number.isSafeInteger(result?.message_id) && result.message_id > 0) {
        // A text command can open an input prompt too; continue it in place when the user replies.
        const user = current().users[reply.userId];
        if (!user.waitingMessageId || user.waitingMessageId === reply.replacesMessageId) user.waitingMessageId = result.message_id;
      }
    }
    catch (error) {
      if (reply.method === 'editMessageText' && error.messageUnavailable) {
        // A deleted/expired menu gets one replacement; transient errors keep retrying the edit.
        reply.replacesMessageId = reply.body.message_id; reply.method = 'sendMessage'; delete reply.body.message_id; persist(); ok = false; continue;
      }
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
