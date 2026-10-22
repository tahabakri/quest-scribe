import { join } from 'node:path';
import { ConfigError, loadConfig } from './config.js';
import { loadDotEnv, readCampaignEnd, readRuntimeEnv, readSheetsEnv, readTelegramEnv } from './env.js';
import { LockError, acquireDataLock } from './lock.js';
import { createLogger, describeError, redactSecrets } from './logger.js';
import { QuestMatcher } from './matcher.js';
import { createGoogleSheetsGateway } from './sheets/gateway.js';
import { startInBackground } from './supervise.js';
import { TelegramAdapter, TelegramAuthError } from './telegram/adapter.js';
import { WAL_FILENAME, WriteAheadLog } from './wal.js';
import { SheetWriter } from './writer.js';

/** How long a clean shutdown may take before the process leaves anyway. */
const SHUTDOWN_GRACE_MS = 20_000;

async function main(): Promise<void> {
  loadDotEnv();
  const env = readRuntimeEnv();
  const log = createLogger(env.logLevel);
  const config = loadConfig();
  const sheetsEnv = readSheetsEnv();
  const telegramEnv = readTelegramEnv();
  const campaignEnd = readCampaignEnd();
  if (campaignEnd) log.info(`submissions are accepted until ${campaignEnd.toISOString()}`);

  acquireDataLock(env.dataDir, 'bot');
  const wal = new WriteAheadLog(join(env.dataDir, WAL_FILENAME));
  const state = wal.open();
  log.info('write-ahead log opened', {
    path: wal.path,
    pending: state.pending.length,
    corruptLines: state.corruptLines,
  });

  const writer = new SheetWriter({
    gateway: createGoogleSheetsGateway(sheetsEnv),
    wal,
    tabs: { submissions: config.sheets.submissionsTab },
    flushIntervalMs: config.sheets.flushIntervalSeconds * 1000,
    flushMaxRows: config.sheets.flushMaxRows,
    log: log.child('sheets'),
  });
  writer.restore(state);

  // A sheet that is unreachable or misconfigured never stops the bot: submissions keep
  // landing in the write-ahead log, and writes resume once the sheet is fixed.
  const sheetReady = await writer.prepare();
  log.info(sheetReady ? 'sheet ready' : 'sheet not usable yet; rows will wait in the write-ahead log');
  writer.start();
  if (state.pending.length > 0) void writer.flush();

  let stopping = false;
  const shutdown = (reason: string, exitCode: number): void => {
    if (stopping) return;
    stopping = true;
    log.info('shutting down', { reason, pending: writer.pendingCount });
    // A stuck network call must not keep the process from ever exiting. Anything still queued is safe in the write-ahead log.
    setTimeout(() => {
      log.warn('shutdown is taking too long; exiting now', { pending: writer.pendingCount });
      process.exit(exitCode);
    }, SHUTDOWN_GRACE_MS).unref();
    // Telegram first: it finishes any album still waiting, which records rows the writer must still flush.
    void telegram
      .stop()
      .catch(() => undefined)
      .then(() => writer.stop())
      .finally(() => {
        wal.close();
        process.exit(exitCode);
      });
  };

  const adapter = new TelegramAdapter({
    token: telegramEnv.token,
    reviewChannelId: telegramEnv.reviewChannelId,
    apiRoot: telegramEnv.apiRoot,
    config,
    matcher: new QuestMatcher(config.quests, config.fuzzyThreshold),
    writer,
    campaignEnd,
    log: log.child('telegram'),
    // The token was refused while running: restarting cannot help, but the host will show the crash.
    onFatal: () => shutdown('Telegram refused the bot token', 1),
  });

  // Started in the background: if Telegram cannot be reached it is retried every 30 seconds,
  // and a refused token ends the process with a message that says what to fix.
  const telegram = startInBackground({
    name: 'Telegram',
    start: async () => {
      const me = await adapter.start();
      log.info(`connected to Telegram as @${me.username}`);
      return adapter;
    },
    isPermanent: (err) => err instanceof TelegramAuthError,
    onPermanent: (err) => {
      log.error((err as Error).message);
      shutdown('Telegram refused the bot token', 1);
    },
    retryMs: 30_000,
    log,
  });

  process.once('SIGINT', () => shutdown('SIGINT', 0));
  process.once('SIGTERM', () => shutdown('SIGTERM', 0));
  process.on('unhandledRejection', (err) => log.error('unhandled promise rejection', { err }));
}

main().catch((err: unknown) => {
  // Configuration problems are fatal and should say exactly what to fix.
  if (err instanceof ConfigError || err instanceof LockError) {
    process.stderr.write(`${redactSecrets(err.message)}\n`);
  } else {
    process.stderr.write(`fatal: ${redactSecrets(describeError(err))}\n`);
  }
  process.exit(1);
});
