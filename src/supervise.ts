import { setTimeout as delay } from 'node:timers/promises';
import type { Logger } from './logger.js';

export interface Stoppable {
  stop(): Promise<void>;
}

export interface BackgroundStart {
  /** Used in log lines: "Telegram", "Discord". */
  name: string;
  /** Brings the platform up. Throws if it cannot. */
  start: () => Promise<Stoppable>;
  /** True for a failure that trying again cannot fix (a refused token). */
  isPermanent: (err: unknown) => boolean;
  /** Called once if the platform is given up on. The rest of the process keeps running. */
  onPermanent: (err: unknown) => void;
  retryMs: number;
  log: Logger;
}

/**
 * Starts a platform without holding up the others. A passing failure (the network, the
 * platform having a bad moment) is retried every `retryMs` until it works; a permanent one
 * is reported once and the platform stays off. `stop()` ends the retrying and stops the
 * platform if it came up, including one that finishes starting after `stop()` was called.
 */
export function startInBackground(options: BackgroundStart): Stoppable {
  const { name, start, isPermanent, onPermanent, retryMs, log } = options;
  const abort = new AbortController();
  let running: Stoppable | undefined;

  const attempt = async (): Promise<void> => {
    while (!abort.signal.aborted) {
      try {
        const started = await start();
        if (abort.signal.aborted) await started.stop().catch(() => undefined);
        else running = started;
        return;
      } catch (err) {
        if (isPermanent(err)) {
          onPermanent(err);
          return;
        }
        log.warn(`could not start ${name}; will try again in ${Math.round(retryMs / 1000)}s`, { err });
        await delay(retryMs, undefined, { signal: abort.signal }).catch(() => undefined);
      }
    }
  };
  void attempt();

  return {
    stop: async () => {
      abort.abort();
      await running?.stop();
    },
  };
}
