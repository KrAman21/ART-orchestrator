import { stopProcessCompose } from './process-compose.js';

async function stopAndExit(kind, error) {
  const normalizedError = error instanceof Error ? error : new Error(String(error));

  process.stderr.write(`[ART_EARLY_FAILURE] ${kind}: ${normalizedError.message}\n`);

  try {
    await stopProcessCompose(`${kind}: ${normalizedError.message}`);
  } catch (stopError) {
    const message = stopError instanceof Error ? stopError.message : String(stopError);
    process.stderr.write(`[ART_EARLY_FAILURE] process-compose stop failed: ${message}\n`);
  }

  process.exit(1);
}

function onUncaughtException(error) {
  void stopAndExit('Uncaught exception during ART startup', error);
}

function onUnhandledRejection(reason) {
  void stopAndExit('Unhandled promise rejection during ART startup', reason);
}

export function uninstallEarlyProcessComposeStop() {
  process.off('uncaughtException', onUncaughtException);
  process.off('unhandledRejection', onUnhandledRejection);
}

process.prependListener('uncaughtException', onUncaughtException);
process.prependListener('unhandledRejection', onUnhandledRejection);

