/** The parts of a configured quest that naming and listing need. */
export interface QuestLike {
  keyword: string;
  type: string;
  name?: string | undefined;
  /** A close variant of the official caption, not something to advertise. */
  review?: boolean | undefined;
}

/** "daily_check_in" -> "Daily Check In". */
export function humanizeType(type: string): string {
  return type
    .split(/[_\s-]+/)
    .filter((word) => word !== '')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/** The name members see for a quest type: the configured one, else a readable form of the type. */
export function questNameFor(quests: readonly QuestLike[], type: string): string {
  return quests.find((quest) => quest.type === type && quest.name !== undefined)?.name ?? humanizeType(type);
}

/**
 * One caption to show per quest type, in config order: the first keyword that is
 * not a close variant (variants exist to catch near-misses, not to be advertised).
 */
export function listedKeywords(quests: readonly QuestLike[]): string[] {
  const listed: string[] = [];
  const seen = new Set<string>();
  for (const quest of quests) {
    if (seen.has(quest.type)) continue;
    const official = quests.find((q) => q.type === quest.type && q.review !== true) ?? quest;
    seen.add(quest.type);
    listed.push(official.keyword);
  }
  return listed;
}

/** What /help sends: the welcome text, then the quest names to use as captions. */
export function buildHelpText(welcome: string, heading: string, quests: readonly QuestLike[]): string {
  return `${welcome}\n\n${heading}\n${listedKeywords(quests)
    .map((keyword) => `- ${keyword}`)
    .join('\n')}`;
}
