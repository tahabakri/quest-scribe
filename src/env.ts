import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ConfigError } from './config.js';
import { type LogLevel, parseLogLevel } from './logger.js';
import type { ServiceAccountCredentials } from './sheets/gateway.js';

/**
 * Loads `.env` into process.env for local runs. Real environment variables win,
 * so a host's dashboard settings are never overridden by a stray file.
 */
export function loadDotEnv(file = '.env'): void {
  if (existsSync(file)) process.loadEnvFile(file);
}

export interface RuntimeEnv {
  logLevel: LogLevel;
  /** Directory for the write-ahead log. Must be persistent storage in production. */
  dataDir: string;
}

export function readRuntimeEnv(env: NodeJS.ProcessEnv = process.env): RuntimeEnv {
  return {
    logLevel: parseLogLevel(env.LOG_LEVEL),
    dataDir: resolve(env.DATA_DIR?.trim() || 'data'),
  };
}

export interface SheetsEnv {
  spreadsheetId: string;
  credentials: ServiceAccountCredentials;
}

export function readSheetsEnv(env: NodeJS.ProcessEnv = process.env): SheetsEnv {
  const rawId = required(env, 'GOOGLE_SHEET_ID');
  // Accept the full URL too: .../spreadsheets/d/<id>/edit
  const spreadsheetId = /\/spreadsheets\/d\/([A-Za-z0-9_-]+)/.exec(rawId)?.[1] ?? rawId;
  if (!/^[A-Za-z0-9_-]{20,}$/.test(spreadsheetId)) {
    throw new ConfigError('GOOGLE_SHEET_ID must be a spreadsheet ID (the part of its URL between /d/ and /edit) or URL');
  }
  return { spreadsheetId, credentials: parseServiceAccount(required(env, 'GOOGLE_SERVICE_ACCOUNT_JSON')) };
}

/**
 * GOOGLE_SERVICE_ACCOUNT_JSON holds either the key file's JSON (one line is
 * safest in env vars) or a path to the key file. Never echoes the value back.
 */
export function parseServiceAccount(raw: string): ServiceAccountCredentials {
  const trimmed = raw.trim();
  let text = trimmed;
  if (!trimmed.startsWith('{')) {
    const path = resolve(trimmed);
    if (!existsSync(path)) {
      throw new ConfigError(
        'GOOGLE_SERVICE_ACCOUNT_JSON must be the service-account key JSON or a path to the key file ' +
          `(no file at ${path})`,
      );
    }
    text = readFileSync(path, 'utf8');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    try {
      // Some dashboards turn the \n escapes inside private_key into real line breaks.
      parsed = JSON.parse(text.replace(/\r?\n/g, '\\n'));
    } catch {
      throw new ConfigError('GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON');
    }
  }

  const { client_email: email, private_key: key } = (parsed ?? {}) as Record<string, unknown>;
  if (typeof email !== 'string' || typeof key !== 'string' || !key.includes('PRIVATE KEY')) {
    throw new ConfigError(
      'GOOGLE_SERVICE_ACCOUNT_JSON must contain client_email and private_key (create a JSON key for the service account)',
    );
  }
  return { client_email: email, private_key: key.replace(/\\n/g, '\n') };
}

export interface TelegramEnv {
  token: string;
  /** The private channel that receives a copy of every submission (starts with -100). */
  reviewChannelId: string;
  /** Only for a self-hosted Bot API server, or for tests: where the Bot API lives. */
  apiRoot?: string;
  /** The community group(s) where members post submissions in the group itself (each starts with -100). */
  groupIds: number[];
}

/**
 * The bot's token and its review channel. Throws a ConfigError, without echoing the
 * token, for a value that is missing or wrong.
 */
export function readTelegramEnv(env: NodeJS.ProcessEnv = process.env): TelegramEnv {
  const token = required(env, 'TELEGRAM_BOT_TOKEN');
  if (!/^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(token)) {
    throw new ConfigError('TELEGRAM_BOT_TOKEN is not a bot token (it looks like 123456789:ABC...). Copy it again from @BotFather.');
  }
  const reviewChannelId = required(env, 'TG_REVIEW_CHANNEL_ID');
  if (!/^-100\d{5,}$/.test(reviewChannelId)) {
    throw new ConfigError('TG_REVIEW_CHANNEL_ID must be a channel ID starting with -100, for example -1001234567890.');
  }
  const apiRoot = env.TELEGRAM_API_ROOT?.trim();
  if (apiRoot !== undefined && apiRoot !== '' && !/^https?:\/\/\S+$/.test(apiRoot)) {
    throw new ConfigError('TELEGRAM_API_ROOT must be a URL such as http://localhost:8081 (leave it unset for the normal Telegram service).');
  }
  const groupIds = (env.TG_GROUP_IDS ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id !== '')
    .map((id) => {
      if (!/^-100\d{5,}$/.test(id)) {
        throw new ConfigError('TG_GROUP_IDS must list group IDs starting with -100, separated by commas, for example -1001234567890.');
      }
      return Number(id);
    });
  return apiRoot ? { token, reviewChannelId, groupIds, apiRoot } : { token, reviewChannelId, groupIds };
}

/**
 * CAMPAIGN_END_UTC: after this moment, submissions are answered
 * with the "ended" reply instead of being logged. It must say UTC explicitly, since
 * a bare date-time would be read in the server's time zone.
 */
export function readCampaignEnd(env: NodeJS.ProcessEnv = process.env): Date | undefined {
  const raw = env.CAMPAIGN_END_UTC?.trim();
  if (!raw) return undefined;
  const date = new Date(raw);
  // JavaScript rolls an impossible date forward (Nov 31 becomes Dec 1), which would close the
  // campaign a day late without a word. Reading the date back must give the same date-time.
  const exact = !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 19) === raw.slice(0, 19);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(raw) || !exact) {
    throw new ConfigError('CAMPAIGN_END_UTC must be a real UTC date-time ending in Z, for example 2026-11-22T23:59:59Z.');
  }
  return date;
}

export function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new ConfigError(`${name} is not set (see .env.example)`);
  return value;
}
