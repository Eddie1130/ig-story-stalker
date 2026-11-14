import { serviceUnavailableText } from './telegram-settings.mjs';
import { telegramApiBase } from './telegram-endpoint.mjs';
// Independent watchdog path: a blocked recipient must not suppress other users.
export async function sendControlFallback({ recipients, ownerId, state, token, signal, persist, log, fetchImpl = fetch }) {
  state.controlFallbackSent ||= {};
  state.controlFallbackUserRetry ||= {};
  if (Date.now() < (state.controlFallbackRetryAt || 0)) return;
  let attempts = 0;
  for (const id of recipients) {
    if (signal.aborted || attempts >= 5) break;
    if (state.controlFallbackSent[id] || Date.now() < (state.controlFallbackUserRetry[id] || 0)) continue;
    attempts++;
    let accepted = false, retry = 0, messageId;
    // Only network/response work belongs in this catch. Persistence failures must
    // escape, including after Telegram has acknowledged a successful send.
    try {
      const response = await fetchImpl(`${telegramApiBase()}/bot${token}/sendMessage`, {
        method: 'POST', signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]),
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: id, text: id === ownerId ? 'IG Telegram 控制服務已失聯，選單與通知可能暫停。獨立 watchdog 仍在運作，請檢查 ig-telegram 容器。' : serviceUnavailableText }),
      });
      const data = await response.json();
      accepted = response.ok && data.ok === true;
      messageId = data.result?.message_id;
      if (!accepted && (data.error_code === 429 || response.status === 429)) {
        const seconds = Number(data.parameters?.retry_after);
        retry = Math.max(60, Number.isFinite(seconds) ? seconds : 60);
      }
    } catch { /* Retry only this recipient; timeouts must not kill the watchdog. */ }
    if (signal.aborted) break;
    if (retry) {
      state.controlFallbackRetryAt = Date.now() + retry * 1000;
      persist(); log('CONTROL_FALLBACK_RETRY', { reason: 'TELEGRAM_ERROR_429' }); break;
    }
    if (accepted) {
      state.controlFallbackSent[id] = true;
      if (Number.isSafeInteger(messageId) && messageId > 0) {
        state.controlFallbackMessages ||= {};
        (state.controlFallbackMessages[id] ||= []).push(messageId);
      }
    }
    else state.controlFallbackUserRetry[id] = Date.now() + 60000;
    persist();
    if (!accepted) log('CONTROL_FALLBACK_RETRY', { userId: id });
  }
}


export async function clearControlFallback({ state, token, signal, persist, fetchImpl = fetch }) {
  // A healthy controller starts a new incident boundary, even if old cleanup must retry.
  if (state.controlFallbackSent) { delete state.controlFallbackSent; delete state.controlFallbackUserRetry; persist(); }
  if (Date.now() < (state.controlFallbackRetryAt || 0)) return false;
  state.controlFallbackCleanupRetry ||= {};
  let ok = true;
  for (const [id, messages] of Object.entries(state.controlFallbackMessages || {})) {
    if (Date.now() < (state.controlFallbackCleanupRetry[id] || 0)) { ok = false; continue; }
    while (messages.length) {
      if (signal.aborted) return false;
      let data, response;
      try {
        response = await fetchImpl(`${telegramApiBase()}/bot${token}/deleteMessage`, {
          method: 'POST', signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]),
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: id, message_id: messages[0] }),
        });
        data = await response.json();
      } catch {
        state.controlFallbackCleanupRetry[id] = Date.now() + 60000; persist(); ok = false; break;
      }
      if (!(response.ok && data.ok === true) && !(data.error_code === 400 && /message to delete not found/.test(data.description || ''))) {
        const retry = Number(data.parameters?.retry_after);
        if (data.error_code === 429 || response.status === 429) {
          state.controlFallbackRetryAt = Date.now() + Math.max(60, Number.isFinite(retry) ? retry : 60) * 1000;
          persist(); return false;
        }
        state.controlFallbackCleanupRetry[id] = Date.now() + 60000; persist(); ok = false; break;
      }
      messages.shift(); persist();
    }
    if (!messages.length) { delete state.controlFallbackMessages[id]; delete state.controlFallbackCleanupRetry[id]; persist(); }
  }
  return ok;
}
