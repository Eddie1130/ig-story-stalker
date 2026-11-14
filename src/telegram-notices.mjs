// Durable message identities let a notice evolve in place and disappear on recovery.
export async function updateNotice(client, state, key, event, persist) {
  state.notices ||= {};
  const record = state.notices[key] ||= { at: -1, messages: [] };
  if (event.at < record.at || (event.at === record.at && record.resolved && !event.recovery)) return;
  if (event.recovery) {
    record.at = event.at; record.resolved = true; delete record.inflight; delete record.uncertain; persist();
    while (record.messages.length) {
      await client.call('deleteMessage', { chat_id: event.userId, message_id: record.messages[0] });
      record.messages.shift(); persist();
    }
    return;
  }
  const messageId = record.messages.at(-1);
  const body = { chat_id: event.userId, text: event.text.slice(0, 4000), link_preview_options: { is_disabled: true } };
  if (messageId) {
    try { await client.call('editMessageText', { ...body, message_id: messageId }); }
    catch (error) {
      if (!error.messageUnavailable) throw error;
      record.messages.pop(); persist();
      return updateNotice(client, state, key, event, persist);
    }
  } else {
    // A crash/network loss after starting a send must not create a second warning on retry.
    if (record.inflight || record.uncertain) { record.uncertain = true; delete record.inflight; persist(); return; }
    try {
      const result = await client.call('sendMessage', body, { beforeRequest: () => { record.inflight = true; persist(); } });
      if (Number.isSafeInteger(result?.message_id) && result.message_id > 0) record.messages.push(result.message_id);
      if (!record.messages.length) record.uncertain = true;
      delete record.inflight;
    } catch (error) {
      if (!/^TELEGRAM_/.test(error.message)) throw error;
      if (record.inflight && !/^(TELEGRAM_RETRY_WAIT|TELEGRAM_STOPPING|TELEGRAM_ERROR_(400|401|403|429))$/.test(error.message)) {
        record.uncertain = true; delete record.inflight; record.at = event.at; persist(); return;
      }
      delete record.inflight; persist(); throw error;
    }
  }
  record.at = event.at; record.resolved = false; persist();
}


export function noticeRecipients(state, event) {
  const recipients = [...event.recipients];
  if (event.noticeKind !== 'recovery') return recipients;
  for (const [key, record] of Object.entries(state.notices || {})) {
    const [userId, scope] = JSON.parse(key);
    if (scope === event.noticeKey && record.messages.length && !recipients.some(r => r.userId === userId)) recipients.push({ userId, generation: 'notice-cleanup' });
  }
  return recipients;
}

export function validateNotices(state) {
  if (state.notices === undefined) return;
  if (!state.notices || typeof state.notices !== 'object' || Array.isArray(state.notices)) throw Error('TELEGRAM_NOTICE_HISTORY_INVALID');
  for (const [key, record] of Object.entries(state.notices)) {
    let identity;
    try { identity = JSON.parse(key); } catch { throw Error('TELEGRAM_NOTICE_HISTORY_INVALID'); }
    if (!Array.isArray(identity) || identity.length !== 2 || !/^[1-9]\d{0,19}$/.test(identity[0]) || typeof identity[1] !== 'string' ||
        !record || !Number.isFinite(record.at) || !Array.isArray(record.messages) || record.messages.some(id => !Number.isSafeInteger(id) || id < 1)) throw Error('TELEGRAM_NOTICE_HISTORY_INVALID');
  }
}
