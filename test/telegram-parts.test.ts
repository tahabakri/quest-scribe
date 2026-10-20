import type { Message } from 'grammy/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AlbumCollector } from '../src/telegram/albums.js';
import { toTgMessage } from '../src/telegram/map.js';
import { firstLinkIn, parseCommand } from '../src/telegram/parse.js';
import type { TgMessage } from '../src/telegram/types.js';

describe('parseCommand', () => {
  it.each([
    ['/start', undefined, { name: 'start', args: '' }],
    ['/start quests', undefined, { name: 'start', args: 'quests' }],
    ['/bind 824000123', undefined, { name: 'bind', args: '824000123' }],
    ['/BIND 123456', undefined, { name: 'bind', args: '123456' }],
    ['/bind   123456  ', undefined, { name: 'bind', args: '123456' }],
    ['/bind@QuestBot 123456', 'QuestBot', { name: 'bind', args: '123456' }],
    ['/bind@questbot 123456', 'QuestBot', { name: 'bind', args: '123456' }],
    ['/help', 'QuestBot', { name: 'help', args: '' }],
    ['/bind 123\n456', undefined, { name: 'bind', args: '123\n456' }],
  ])('%j -> %j', (input, bot, expected) => {
    expect(parseCommand(input, bot)).toEqual(expected);
  });

  it.each([
    ['plain text', 'bind 123456'],
    ['a slash in the middle', 'please /bind 123456'],
    ['a lone slash', '/'],
    ['a path', '/usr/bin/env x'],
    ['an empty string', ''],
  ])('does not treat %s as a command', (_label, input) => {
    expect(parseCommand(input)).toBeUndefined();
  });

  it('ignores a command addressed to a different bot', () => {
    expect(parseCommand('/bind@SomeoneElseBot 123456', 'QuestBot')).toBeUndefined();
  });

  it('has nothing to parse without text', () => {
    expect(parseCommand(undefined)).toBeUndefined();
  });
});

describe('firstLinkIn', () => {
  it('finds a visible link, with the same cleanup as on Discord', () => {
    expect(firstLinkIn('look: https://example.com/a. nice', [])).toBe('https://example.com/a');
  });

  it('finds a link hidden behind words (a text_link entity), which is not in the text', () => {
    expect(firstLinkIn('my video', [{ type: 'text_link', offset: 3, length: 5, url: 'https://example.com/v' }])).toBe(
      'https://example.com/v',
    );
  });

  it('takes whichever comes first when both exist', () => {
    const entities = [{ type: 'text_link', offset: 20, length: 4, url: 'https://hidden.example.com' }];
    expect(firstLinkIn('see https://visible.example.com and this one', entities)).toBe('https://visible.example.com');
    expect(firstLinkIn('this one and https://visible.example.com', [{ type: 'text_link', offset: 0, length: 8, url: 'https://hidden.example.com' }])).toBe(
      'https://hidden.example.com',
    );
  });

  it('ignores hidden links that are not http(s) or do not parse', () => {
    expect(firstLinkIn('open', [{ type: 'text_link', offset: 0, length: 4, url: 'tg://resolve?domain=x' }])).toBeUndefined();
    expect(firstLinkIn('open', [{ type: 'text_link', offset: 0, length: 4, url: 'javascript:alert(1)' }])).toBeUndefined();
    expect(firstLinkIn('open', [{ type: 'text_link', offset: 0, length: 4, url: 'https://' }])).toBeUndefined();
  });

  it('ignores a mention, a hashtag and a bare domain', () => {
    expect(firstLinkIn('@someone #tag example.com', [])).toBeUndefined();
  });
});

describe('AlbumCollector', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const part = (messageId: number, overrides: Partial<TgMessage> = {}): TgMessage => ({
    chatId: 1,
    chatType: 'private',
    messageId,
    date: new Date('2026-11-01T10:00:00Z'),
    fromId: 1,
    fromIsBot: false,
    username: '@m',
    text: undefined,
    caption: undefined,
    entities: [],
    command: undefined,
    images: [{ fileId: `f${messageId}`, messageId }],
    mediaGroupId: 'g',
    ...overrides,
  });

  it('hands the parts over together, lowest message id first, once nothing more arrives', async () => {
    vi.useFakeTimers();
    const albums: number[][] = [];
    const collector = new AlbumCollector((parts) => {
      albums.push(parts.map((p) => p.messageId));
      return Promise.resolve();
    }, 1000);
    collector.add(part(3));
    collector.add(part(1));
    collector.add(part(2));
    expect(collector.pending).toBe(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(albums).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(albums).toEqual([[1, 2, 3]]);
    expect(collector.pending).toBe(0);
  });

  it('waits again every time another part arrives', async () => {
    vi.useFakeTimers();
    const albums: number[][] = [];
    const collector = new AlbumCollector((parts) => {
      albums.push(parts.map((p) => p.messageId));
      return Promise.resolve();
    }, 1000);
    collector.add(part(1));
    await vi.advanceTimersByTimeAsync(800);
    collector.add(part(2));
    await vi.advanceTimersByTimeAsync(800);
    expect(albums).toEqual([]);
    await vi.advanceTimersByTimeAsync(200);
    expect(albums).toEqual([[1, 2]]);
  });

  it('keeps albums apart by chat and by group', async () => {
    vi.useFakeTimers();
    const albums: number[][] = [];
    const collector = new AlbumCollector((parts) => {
      albums.push(parts.map((p) => p.messageId));
      return Promise.resolve();
    }, 1000);
    collector.add(part(1, { mediaGroupId: 'a' }));
    collector.add(part(2, { mediaGroupId: 'b' }));
    collector.add(part(3, { mediaGroupId: 'a', chatId: 2 }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(albums.sort()).toEqual([[1], [2], [3]]);
  });

  it('recognises a part that turns up after its album was handed over, for a while', async () => {
    vi.useFakeTimers();
    const albums: number[][] = [];
    const collector = new AlbumCollector((parts) => {
      albums.push(parts.map((p) => p.messageId));
      return Promise.resolve();
    }, 1000);
    expect(collector.add(part(1))).toBe('queued');
    expect(collector.add(part(2))).toBe('queued');
    await vi.advanceTimersByTimeAsync(1000);
    expect(albums).toEqual([[1, 2]]);

    expect(collector.add(part(3))).toBe('late'); // the same album, too late to join it
    expect(collector.add(part(4, { mediaGroupId: 'other' }))).toBe('queued'); // a different album is unaffected
    expect(collector.add(part(5, { chatId: 2 }))).toBe('queued'); // so is the same id in another chat
    await vi.advanceTimersByTimeAsync(1000);
    expect(albums).toEqual([[1, 2], [4], [5]]); // the late part started nothing

    await vi.advanceTimersByTimeAsync(11 * 60_000);
    expect(collector.add(part(6))).toBe('queued'); // long after: treated as new, so memory stays bounded
  });

  it('flushAll() releases everything at once, and the timers do not fire twice', async () => {
    vi.useFakeTimers();
    const albums: number[][] = [];
    const collector = new AlbumCollector((parts) => {
      albums.push(parts.map((p) => p.messageId));
      return Promise.resolve();
    }, 1000);
    collector.add(part(1));
    collector.add(part(2, { mediaGroupId: 'other' }));
    await collector.flushAll();
    expect(albums.sort()).toEqual([[1], [2]]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(albums).toHaveLength(2);
  });
});

// A message shaped like what Telegram sends, built from plain objects.
function raw(extra: Record<string, unknown>): Message {
  return {
    message_id: 77,
    date: 1_793_000_000,
    chat: { id: 5000, type: 'private', first_name: 'Sam' },
    from: { id: 5000, is_bot: false, first_name: 'Sam', username: 'sam_q' },
    ...extra,
  } as unknown as Message;
}
const options = { botUsername: 'QuestBot', imageExtensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] };

describe('toTgMessage', () => {
  it('reads who sent it, where, and when', () => {
    const m = toTgMessage(raw({ text: 'hi' }), options);
    expect(m).toMatchObject({
      chatId: 5000,
      chatType: 'private',
      messageId: 77,
      fromId: 5000,
      fromIsBot: false,
      username: '@sam_q',
      text: 'hi',
      images: [],
      command: undefined,
    });
    expect(m.date.toISOString()).toBe(new Date(1_793_000_000 * 1000).toISOString());
  });

  it('uses the first name when the member has no @handle', () => {
    const m = toTgMessage(raw({ text: 'hi', from: { id: 9, is_bot: false, first_name: 'Noor' } }), options);
    expect(m.username).toBe('Noor');
  });

  it('takes the largest size of a photo, by file_id', () => {
    const m = toTgMessage(
      raw({
        caption: 'share post',
        photo: [
          { file_id: 'small', file_unique_id: 'a', width: 90, height: 90 },
          { file_id: 'medium', file_unique_id: 'b', width: 320, height: 320 },
          { file_id: 'large', file_unique_id: 'c', width: 1280, height: 1280 },
        ],
      }),
      options,
    );
    expect(m.images).toEqual([{ fileId: 'large', messageId: 77 }]);
    expect(m.caption).toBe('share post');
  });

  it.each([
    ['a png file', { file_id: 'd1', file_name: 'shot.png', mime_type: 'image/png' }, true],
    ['a jpeg by type alone', { file_id: 'd2', mime_type: 'image/jpeg' }, true],
    ['a webp by name alone', { file_id: 'd3', file_name: 'IMG.WEBP' }, true],
    ['a gif file', { file_id: 'd4', file_name: 'anim.gif', mime_type: 'image/gif' }, true],
    ['a pdf', { file_id: 'd5', file_name: 'doc.pdf', mime_type: 'application/pdf' }, false],
    ['a video', { file_id: 'd6', file_name: 'clip.mp4', mime_type: 'video/mp4' }, false],
    ['an unsupported image type', { file_id: 'd7', file_name: 'pic.heic', mime_type: 'image/heic' }, false],
  ])('treats %s as an image: %s', (_label, document, isImage) => {
    const m = toTgMessage(raw({ caption: 'x', document }), options);
    expect(m.images.length).toBe(isImage ? 1 : 0);
    if (isImage) expect(m.images[0]!.fileId).toBe((document as { file_id: string }).file_id);
  });

  it('has no image for a sticker, a voice note or a plain message', () => {
    expect(toTgMessage(raw({ sticker: { file_id: 's' } }), options).images).toEqual([]);
    expect(toTgMessage(raw({ voice: { file_id: 'v' } }), options).images).toEqual([]);
  });

  it('reads a command only when Telegram marks one at the very start', () => {
    const start = toTgMessage(raw({ text: '/bind 824000123', entities: [{ type: 'bot_command', offset: 0, length: 5 }] }), options);
    expect(start.command).toEqual({ name: 'bind', args: '824000123' });

    const middle = toTgMessage(raw({ text: 'try /bind 123456', entities: [{ type: 'bot_command', offset: 4, length: 5 }] }), options);
    expect(middle.command).toBeUndefined();

    const typed = toTgMessage(raw({ text: '/bind 123456' }), options); // no entity: not a command to Telegram
    expect(typed.command).toBeUndefined();
  });

  it('ignores a command addressed to another bot', () => {
    const m = toTgMessage(raw({ text: '/bind@OtherBot 123456', entities: [{ type: 'bot_command', offset: 0, length: 14 }] }), options);
    expect(m.command).toBeUndefined();
  });

  it('keeps hidden-link entities, from the text or from the caption', () => {
    const fromText = toTgMessage(
      raw({ text: 'my video', entities: [{ type: 'text_link', offset: 3, length: 5, url: 'https://example.com/v' }] }),
      options,
    );
    expect(fromText.entities).toEqual([{ type: 'text_link', offset: 3, length: 5, url: 'https://example.com/v' }]);

    const fromCaption = toTgMessage(
      raw({ caption: 'share post', caption_entities: [{ type: 'bold', offset: 0, length: 5 }], photo: [{ file_id: 'p', file_unique_id: 'u', width: 1, height: 1 }] }),
      options,
    );
    expect(fromCaption.entities).toEqual([{ type: 'bold', offset: 0, length: 5, url: undefined }]);
  });

  it('carries the album id, and survives a channel post that has no sender', () => {
    expect(toTgMessage(raw({ media_group_id: 'grp-1' }), options).mediaGroupId).toBe('grp-1');
    const channel = toTgMessage(raw({ chat: { id: -100123, type: 'channel', title: 'News' }, from: undefined, text: 'hi' }), options);
    expect(channel).toMatchObject({ chatType: 'channel', fromId: undefined, fromIsBot: false, username: '' });
  });

  it('marks a message from a bot', () => {
    expect(toTgMessage(raw({ from: { id: 1, is_bot: true, first_name: 'B' }, text: 'x' }), options).fromIsBot).toBe(true);
  });
});
