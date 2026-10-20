import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { keywordProblems } from './matcher.js';
import { buildHelpText } from './quests.js';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** quest_type written when an image submission matches no keyword, even loosely. */
export const UNMATCHED_QUEST_TYPE = 'unmatched';

const TELEGRAM_MESSAGE_LIMIT = 4096;

const int = (min: number, max: number) =>
  z.preprocess((v) => (typeof v === 'bigint' ? Number(v) : v), z.number().int().min(min).max(max));

const fraction = z.preprocess(
  (v) => (typeof v === 'bigint' ? Number(v) : v),
  z.number().gt(0, 'must be greater than 0').max(1, 'must be at most 1'),
);

const replyText = z.string().trim().min(1).max(1800);

const questType = z
  .string()
  .trim()
  .min(1)
  .refine((v) => v !== UNMATCHED_QUEST_TYPE, `"${UNMATCHED_QUEST_TYPE}" is reserved for captions that match nothing`);

const regexSource = z
  .string()
  .min(1)
  .superRefine((source, ctx) => {
    try {
      new RegExp(source, 'u');
    } catch (err) {
      ctx.addIssue({ code: 'custom', message: `is not a valid regular expression: ${(err as Error).message}` });
    }
  });

const QuestSchema = z.strictObject({
  keyword: z.string().trim().min(1),
  type: questType,
  /** What members see for this quest ("Logged: <name>"). Defaults to a readable form of the type. */
  name: z.string().trim().min(1).max(60).optional(),
  strict: z.boolean().default(false),
  review: z.boolean().default(false),
});

const DEFAULT_WELCOME = [
  'Welcome!',
  '',
  '1. Link your account: /bind 123456789',
  '2. Complete a quest',
  '3. Send the screenshot here with the quest name as the caption',
  '',
  'To share something you made, just send the link.',
].join('\n');

// Defaults are generic on purpose; a deployment sets its own wording in config.yml.
const TelegramSchema = z.strictObject({
  /** The /start text. /help adds the list of quest names. */
  welcome: z.string().trim().min(1).max(3000).default(DEFAULT_WELCOME),
  help_quests_heading: z.string().trim().min(1).max(200).default('Quest names, to use as the caption:'),
  /** quest_type for a message that contains a link and no image. */
  link_quest_type: questType.default('content_link'),
  replies: z
    .strictObject({
      bind_usage: replyText.default('To link your account, send /bind followed by your ID, for example: /bind 123456789'),
      bind_invalid: replyText.default("That doesn't look like a valid ID. Use numbers only, for example: /bind 123456789"),
      group_bind: replyText.default('Please message me in a private chat to take part.'),
      /** {quest} is replaced with the quest's name. */
      logged: replyText.default('Logged: {quest}. Thank you!'),
      unmatched: replyText.default(
        "We couldn't match that to a quest, so we've saved it for a person to review. Next time, put the quest name in the caption.",
      ),
      no_caption: replyText.default('Saved. Next time, add the quest name as the caption.'),
      no_image: replyText.default('Please attach a screenshot with your submission.'),
      unbound: replyText.default('Please run /bind with your ID first, so we can link your submissions to your account.'),
      ugc_logged: replyText.default('Logged your link. Thank you!'),
      error: replyText.default('Something went wrong on our side. Please try again in a minute.'),
    })
    .prefault({}),
});

const RawConfigSchema = z
  .strictObject({
    quests: z.array(QuestSchema).min(1, 'define at least one quest'),
    fuzzy_threshold: fraction.default(0.8),
    bind: z
      .strictObject({
        id_pattern: regexSource.default('^\\d{6,15}$'),
        replies: z
          .strictObject({
            success: replyText.default("Your account ID has been linked. You're all set."),
            error: replyText.default('Something went wrong saving that. Please try again in a minute.'),
          })
          .prefault({}),
      })
      .prefault({}),
    replies: z
      .strictObject({
        /** Shown, instead of logging, for submissions after CAMPAIGN_END_UTC. */
        ended: replyText.default('This campaign has ended. Thank you for joining in!'),
      })
      .prefault({}),
    telegram: TelegramSchema.prefault({}),
    image_extensions: z
      .array(z.string().trim().min(1))
      .min(1)
      .default(['png', 'jpg', 'jpeg', 'gif', 'webp']),
    sheets: z
      .strictObject({
        binds_tab: z.string().trim().min(1).max(100).default('Binds'),
        submissions_tab: z.string().trim().min(1).max(100).default('Submissions'),
        flush_interval_seconds: int(1, 300).default(5),
        flush_max_rows: int(1, 500).default(20),
        binds_refresh_minutes: int(0, 1440).default(10),
      })
      .prefault({}),
  })
  .superRefine((cfg, ctx) => {
    for (const problem of keywordProblems(cfg.quests)) {
      ctx.addIssue({ code: 'custom', path: ['quests', problem.index, 'keyword'], message: problem.message });
    }
    if (cfg.sheets.binds_tab === cfg.sheets.submissions_tab) {
      ctx.addIssue({ code: 'custom', path: ['sheets', 'submissions_tab'], message: 'must differ from binds_tab' });
    }
    // One display name per quest type.
    const nameByType = new Map<string, string>();
    cfg.quests.forEach((quest, i) => {
      if (quest.name === undefined) return;
      const existing = nameByType.get(quest.type);
      if (existing !== undefined && existing !== quest.name) {
        ctx.addIssue({ code: 'custom', path: ['quests', i, 'name'], message: `quest type "${quest.type}" already has a different name` });
      } else {
        nameByType.set(quest.type, quest.name);
      }
    });
    // /help is one Telegram message: the welcome text plus the list of quest names.
    const help = buildHelpText(cfg.telegram.welcome, cfg.telegram.help_quests_heading, cfg.quests);
    if (help.length > TELEGRAM_MESSAGE_LIMIT) {
      ctx.addIssue({
        code: 'custom',
        path: ['telegram', 'welcome'],
        message: `the /help message (welcome text plus ${cfg.quests.length} quest names) is ${help.length} characters; Telegram allows ${TELEGRAM_MESSAGE_LIMIT}. Shorten the welcome text.`,
      });
    }
  });

type RawConfig = z.output<typeof RawConfigSchema>;

export interface Quest {
  keyword: string;
  type: string;
  /** Display name for this quest type. Defaults to a readable form of the type. */
  name?: string;
  /**
   * Whole-word matches only, with no typo tolerance. For short keywords that
   * would otherwise match inside other words ("join" in "joint").
   */
  strict?: boolean;
  /**
   * A close variant rather than the official caption (a quest's name, an "-ing" form).
   * Submissions that match it are logged under the quest with fuzzy_match = TRUE, so
   * they stand out for manual review.
   */
  review?: boolean;
}

export interface AppConfig {
  quests: Quest[];
  fuzzyThreshold: number;
  bind: {
    idPattern: RegExp;
    replies: { success: string; error: string };
  };
  replies: { ended: string };
  telegram: {
    welcome: string;
    helpQuestsHeading: string;
    linkQuestType: string;
    replies: {
      bindUsage: string;
      bindInvalid: string;
      groupBind: string;
      /** {quest} stands for the quest's name. */
      logged: string;
      unmatched: string;
      noCaption: string;
      noImage: string;
      unbound: string;
      ugcLogged: string;
      error: string;
    };
  };
  imageExtensions: string[];
  sheets: {
    bindsTab: string;
    submissionsTab: string;
    flushIntervalSeconds: number;
    flushMaxRows: number;
    bindsRefreshMinutes: number;
  };
}

export interface ConfigSource {
  text: string;
  /** Human-readable origin for error messages: a file path or "CONFIG_YAML". */
  origin: string;
}

/**
 * CONFIG_YAML (the whole file in one env var) wins, for hosts without file mounts;
 * otherwise the file at CONFIG_PATH, defaulting to ./config.yml.
 */
export function readConfigSource(env: NodeJS.ProcessEnv = process.env): ConfigSource {
  const inline = env.CONFIG_YAML;
  if (inline && inline.trim() !== '') return { text: inline, origin: 'CONFIG_YAML' };
  const path = resolve(env.CONFIG_PATH?.trim() || 'config.yml');
  if (!existsSync(path)) {
    throw new ConfigError(
      `No config found: ${path} does not exist and CONFIG_YAML is not set. ` +
        'Copy config.example.yml to config.yml to get started.',
    );
  }
  return { text: readFileSync(path, 'utf8'), origin: path };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return parseConfig(readConfigSource(env), env);
}

/**
 * Only the sheet tab names, for recovery tools like `npm run replay`: they must
 * work even where unrelated settings are absent.
 */
export function readSheetTabs(env: NodeJS.ProcessEnv = process.env): { submissions: string; binds: string } {
  const source = readConfigSource(env);
  let doc: unknown;
  try {
    doc = parseYaml(source.text, { intAsBigInt: true });
  } catch (err) {
    throw new ConfigError(`${source.origin}: invalid YAML: ${(err as Error).message}`);
  }
  const sheets = (doc as { sheets?: unknown } | null)?.sheets ?? {};
  const result = z
    .looseObject({
      binds_tab: z.string().trim().min(1).default('Binds'),
      submissions_tab: z.string().trim().min(1).default('Submissions'),
    })
    .safeParse(interpolateEnv(sheets, env, new Set()));
  if (!result.success) throw new ConfigError(`${source.origin}: invalid sheets settings`);
  return { submissions: result.data.submissions_tab, binds: result.data.binds_tab };
}

export function parseConfig(source: ConfigSource, env: NodeJS.ProcessEnv = process.env): AppConfig {
  let doc: unknown;
  try {
    doc = parseYaml(source.text, { intAsBigInt: true });
  } catch (err) {
    throw new ConfigError(`${source.origin}: invalid YAML: ${(err as Error).message}`);
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new ConfigError(`${source.origin}: expected a YAML mapping at the top level`);
  }

  const missing = new Set<string>();
  const interpolated = interpolateEnv(withoutDiscordKeys(doc as Record<string, unknown>), env, missing);
  if (missing.size > 0) {
    throw new ConfigError(
      `${source.origin}: references environment variable(s) that are not set: ${[...missing].join(', ')}`,
    );
  }

  const result = RawConfigSchema.safeParse(interpolated);
  if (!result.success) {
    const lines = result.error.issues.map(
      (issue) =>
        `  - ${formatPath(issue.path)}: ${issue.message.replace(/^Invalid input: expected (\w+), received undefined$/, 'is required ($1)')}`,
    );
    throw new ConfigError(`${source.origin}: invalid config\n${lines.join('\n')}`);
  }
  return toAppConfig(result.data);
}

/**
 * One config file can serve this bot and the Discord bot of the same campaign, so the
 * quest list is written once. Each bot ignores what belongs to the other. The Discord-only
 * keys are removed before ${VAR} references are resolved, so variables only the Discord
 * bot needs (channel IDs, a role ID) do not have to be set here.
 */
function withoutDiscordKeys(doc: Record<string, unknown>): Record<string, unknown> {
  const isMap = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);
  const drop = (value: unknown, keys: readonly string[]): unknown =>
    isMap(value) ? Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key))) : value;

  const out: Record<string, unknown> = { ...doc };
  for (const key of ['channels', 'reactions', 'warning_delete_after_seconds']) delete out[key];
  if (Array.isArray(out.quests)) out.quests = out.quests.map((quest) => drop(quest, ['reply']));
  if (isMap(out.replies)) out.replies = drop(out.replies, ['unmatched', 'no_image', 'unbound']);
  if (isMap(out.bind)) {
    const bind = drop(out.bind, ['command', 'command_description', 'id_label', 'id_description', 'role_id']) as Record<string, unknown>;
    if (isMap(bind.replies)) bind.replies = drop(bind.replies, ['invalid']);
    out.bind = bind;
  }
  return out;
}

/** Replaces ${VAR} in every string value with process env values. */
function interpolateEnv(value: unknown, env: NodeJS.ProcessEnv, missing: Set<string>): unknown {
  if (typeof value === 'string') {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
      const replacement = env[name];
      if (replacement === undefined || replacement.trim() === '') {
        missing.add(name);
        return '';
      }
      return replacement.trim();
    });
  }
  if (Array.isArray(value)) return value.map((item) => interpolateEnv(item, env, missing));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, interpolateEnv(v, env, missing)]),
    );
  }
  return value;
}

function formatPath(path: PropertyKey[]): string {
  if (path.length === 0) return '(root)';
  return path
    .map((part, i) => (typeof part === 'number' ? `[${part}]` : `${i === 0 ? '' : '.'}${String(part)}`))
    .join('');
}

function toAppConfig(raw: RawConfig): AppConfig {
  return {
    quests: raw.quests.map((q) => ({
      keyword: q.keyword,
      type: q.type,
      name: q.name,
      strict: q.strict,
      review: q.review,
    })),
    fuzzyThreshold: raw.fuzzy_threshold,
    bind: {
      idPattern: new RegExp(raw.bind.id_pattern, 'u'),
      replies: raw.bind.replies,
    },
    replies: { ended: raw.replies.ended },
    telegram: {
      welcome: raw.telegram.welcome,
      helpQuestsHeading: raw.telegram.help_quests_heading,
      linkQuestType: raw.telegram.link_quest_type,
      replies: {
        bindUsage: raw.telegram.replies.bind_usage,
        bindInvalid: raw.telegram.replies.bind_invalid,
        groupBind: raw.telegram.replies.group_bind,
        logged: raw.telegram.replies.logged,
        unmatched: raw.telegram.replies.unmatched,
        noCaption: raw.telegram.replies.no_caption,
        noImage: raw.telegram.replies.no_image,
        unbound: raw.telegram.replies.unbound,
        ugcLogged: raw.telegram.replies.ugc_logged,
        error: raw.telegram.replies.error,
      },
    },
    imageExtensions: raw.image_extensions.map((ext) => ext.replace(/^\./, '').toLowerCase()),
    sheets: {
      bindsTab: raw.sheets.binds_tab,
      submissionsTab: raw.sheets.submissions_tab,
      flushIntervalSeconds: raw.sheets.flush_interval_seconds,
      flushMaxRows: raw.sheets.flush_max_rows,
      bindsRefreshMinutes: raw.sheets.binds_refresh_minutes,
    },
  };
}
