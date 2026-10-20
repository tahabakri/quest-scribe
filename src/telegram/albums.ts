import type { TgMessage } from './types.js';

/** Long enough for the slowest delivery in practice, short enough that a person is not left waiting for the reply. */
const DEFAULT_WAIT_MS = 2000;
/** How long after an album was handed over a straggler is still recognised as belonging to it. */
const LATE_PART_WINDOW_MS = 10 * 60_000;

/**
 * Telegram delivers an album (several photos sent at once) as separate messages that
 * share a media_group_id, with the caption on just one of them. They are gathered
 * here until nothing more arrives for `waitMs`, then handed over together so the
 * album becomes one submission.
 *
 * The gathering happens outside the update handler on purpose: updates are handled
 * one at a time, so a handler that waited for its siblings would wait forever.
 *
 * A photo that turns up after its album was handed over is reported as `late` instead of
 * starting a second album, so a slow delivery cannot become a second, caption-less row.
 */
export class AlbumCollector {
  private readonly groups = new Map<string, { parts: TgMessage[]; timer: NodeJS.Timeout }>();
  /** Albums handed over recently, with when. Forgotten after LATE_PART_WINDOW_MS, so this stays small. */
  private readonly released = new Map<string, number>();

  constructor(
    private readonly onAlbum: (parts: TgMessage[]) => Promise<void>,
    private readonly waitMs = DEFAULT_WAIT_MS,
  ) {}

  add(message: TgMessage): 'queued' | 'late' {
    const key = `${message.chatId}:${message.mediaGroupId ?? message.messageId}`;
    const existing = this.groups.get(key);
    if (existing) clearTimeout(existing.timer);
    else if (this.wasReleased(key)) return 'late';
    const parts = existing?.parts ?? [];
    parts.push(message);
    const timer = setTimeout(() => void this.release(key), this.waitMs);
    timer.unref();
    this.groups.set(key, { parts, timer });
    return 'queued';
  }

  get pending(): number {
    return this.groups.size;
  }

  /** Hands over everything still waiting, without delay. Used at shutdown so no album is dropped. */
  async flushAll(): Promise<void> {
    await Promise.all([...this.groups.keys()].map((key) => this.release(key)));
  }

  private wasReleased(key: string): boolean {
    const now = Date.now();
    for (const [k, at] of this.released) if (now - at > LATE_PART_WINDOW_MS) this.released.delete(k);
    return this.released.has(key);
  }

  private async release(key: string): Promise<void> {
    const group = this.groups.get(key);
    if (!group) return;
    clearTimeout(group.timer);
    this.groups.delete(key);
    this.released.set(key, Date.now());
    // Delivery order is not guaranteed; the lowest message id is the album's first image.
    await this.onAlbum([...group.parts].sort((a, b) => a.messageId - b.messageId));
  }
}
