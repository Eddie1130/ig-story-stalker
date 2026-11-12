// Independent watchdog path: a blocked recipient must not suppress other users.
export async function sendControlFallback({ recipients, state, token, signal, persist, log, fetchImpl = fetch }) {
  state.controlFallbackSent ||= {};
  state.controlFallbackUserRetry ||= {};
  if (Date.now() < (state.controlFallbackRetryAt || 0)) return;
  let attempts = 0;
  for (const id of recipients) {
    if (signal.aborted || attempts >= 5) break;
    if (state.controlFallbackSent[id] || Date.now() < (state.controlFallbackUserRetry[id] || 0)) continue;
    attempts++;
    let accepted = false, retry = 0;
    // Only network/response work belongs in this catch. Persistence failures must
    // escape, including after Telegram has acknowledged a successful send.
    try {
      const response = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST', signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]),
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: id, text: 'IG Telegram 控制服務已失聯，選單與通知可能暫停。獨立 watchdog 仍在運作，請檢查 ig-telegram 容器。' }),
      });
      const data = await response.json();
      accepted = response.ok && data.ok === true;
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
    if (accepted) state.controlFallbackSent[id] = true;
    else state.controlFallbackUserRetry[id] = Date.now() + 60000;
    persist();
    if (!accepted) log('CONTROL_FALLBACK_RETRY', { userId: id });
  }
}
