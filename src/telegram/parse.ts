import { extractFirstLink } from '../submissions.js';
import type { TgCommand, TgEntity } from './types.js';

/**
 * "/start quests", "/help@MyBot". Undefined for ordinary
 * text, and for a command addressed to a different bot (in a group several bots
 * can share a command name).
 */
export function parseCommand(text: string | undefined, botUsername?: string): TgCommand | undefined {
  if (text === undefined) return undefined;
  const match = /^\/([A-Za-z0-9_]{1,32})(?:@([A-Za-z0-9_]+))?(?:\s+([\s\S]*))?$/.exec(text);
  if (!match) return undefined;
  const target = match[2];
  if (target !== undefined && botUsername !== undefined && target.toLowerCase() !== botUsername.toLowerCase()) return undefined;
  return { name: (match[1] ?? '').toLowerCase(), args: (match[3] ?? '').trim() };
}

/**
 * The first http(s) link in a message. Telegram lets a member hide a link behind
 * ordinary words ("my video"): the URL is then not in the text at all but in a
 * text_link entity, so both places are looked at and whichever comes first wins.
 */
export function firstLinkIn(text: string, entities: readonly TgEntity[]): string | undefined {
  const hidden = entities
    .filter((e) => e.type === 'text_link' && e.url !== undefined && /^https?:\/\//i.test(e.url) && URL.canParse(e.url))
    .sort((a, b) => a.offset - b.offset)[0];
  const visible = extractFirstLink(text);
  if (hidden?.url === undefined) return visible;
  if (visible === undefined) return hidden.url;
  const visibleAt = text.toLowerCase().indexOf(visible.toLowerCase());
  return visibleAt >= 0 && visibleAt < hidden.offset ? visible : hidden.url;
}
