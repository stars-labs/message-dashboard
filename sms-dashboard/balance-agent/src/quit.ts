import { errorText } from '../../shared/error-text.js';

// The caller has already cancelled will-quit to run the shutdown, and once a window
// has been open Electron ignores a second app.quit() (GRA-230), so this exits directly.
export async function shutdownThenExit({
  shutdown,
  exit,
  logger,
}: {
  shutdown: () => Promise<void>;
  exit: (code: number) => void;
  logger: { error(message: string): void };
}): Promise<void> {
  try {
    await shutdown();
  } catch (error) {
    logger.error(`Balance Agent shutdown failed: ${errorText(error)}`);
    exit(1);
    return;
  }
  exit(0);
}
