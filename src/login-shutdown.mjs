export function closeBrowserOnShutdown(
  browserContext,
  signalEmitter = process,
) {
  return new Promise((resolve, reject) => {
    let shutdownStarted = false;

    const removeListeners = () => {
      signalEmitter.off('SIGINT', onSigint);
      signalEmitter.off('SIGTERM', onSigterm);
      browserContext.off('close', onBrowserClosed);
    };

    const finishShutdown = async reason => {
      if (shutdownStarted) {
        return;
      }

      shutdownStarted = true;

      try {
        if (reason !== 'browser_closed') {
          await browserContext.close();
        }

        removeListeners();
        resolve(reason);
      } catch (error) {
        removeListeners();
        reject(error);
      }
    };

    const onSigint = () => void finishShutdown('SIGINT');
    const onSigterm = () => void finishShutdown('SIGTERM');
    const onBrowserClosed = () => void finishShutdown('browser_closed');

    signalEmitter.on('SIGINT', onSigint);
    signalEmitter.on('SIGTERM', onSigterm);
    browserContext.on('close', onBrowserClosed);
  });
}
