import { describe, expect, it } from 'vitest';
import { QuestMatcher } from '../src/matcher.js';
import {
  buildSubmissionRow,
  classifyImageMessage,
  extractFirstLink,
  isImageAttachment,
} from '../src/submissions.js';

const matcher = new QuestMatcher(
  [
    { keyword: 'share post', type: 'share_post' },
    { keyword: 'boost post', type: 'boost_post' },
  ],
  0.8,
);

describe('classifyImageMessage', () => {
  const run = (text: string, hasImage: boolean) => classifyImageMessage({ text, hasImage }, matcher);

  it.each([
    ['image + keyword', 'share post', true, { action: 'log', questType: 'share_post', fuzzy: false, reaction: 'success', warnings: [] }],
    ['image + typo', 'shre post', true, { action: 'log', questType: 'share_post', fuzzy: true, reaction: 'success', warnings: [] }],
    ['image + unrelated caption', 'look at this', true, { action: 'log', questType: 'unmatched', fuzzy: false, reaction: 'attention', warnings: ['unmatched'] }],
    ['image + empty caption', '', true, { action: 'log', questType: 'unmatched', fuzzy: false, reaction: 'attention', warnings: ['unmatched'] }],
    ['keyword without image', 'share post', false, { action: 'warn', reaction: 'attention', warnings: ['noImage'] }],
    ['typo without image', 'shre post', false, { action: 'warn', reaction: 'attention', warnings: ['noImage'] }],
    ['chat without image', 'good morning all', false, { action: 'ignore' }],
  ])('%s', (_label, text, hasImage, expected) => {
    expect(run(text, hasImage)).toEqual(expected);
  });
});

describe('classifyImageMessage: close variants', () => {
  const variantMatcher = new QuestMatcher(
    [
      { keyword: 'share post', type: 'share_post' },
      { keyword: 'sharing post', type: 'share_post', review: true },
    ],
    0.8,
  );
  const run = (text: string) => classifyImageMessage({ text, hasImage: true }, variantMatcher);

  it('flags a close variant for manual review, like a typo, and still counts it as a success', () => {
    expect(run('sharing post')).toEqual({
      action: 'log',
      questType: 'share_post',
      fuzzy: true,
      reaction: 'success',
      warnings: [],
    });
  });

  it('does not flag the official caption', () => {
    expect(run('share post')).toMatchObject({ questType: 'share_post', fuzzy: false });
  });
});

describe('isImageAttachment', () => {
  const EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp'];
  it.each([
    ['shot.png', null, true],
    ['SHOT.JPG', null, true],
    ['photo.webp', 'image/webp', true],
    ['image', 'image/jpeg', true], // no extension, trust the MIME type
    ['clip.mp4', 'video/mp4', false],
    ['doc.pdf', 'application/pdf', false],
    ['photo.heic', 'image/heic', false],
  ])('%s (%s) -> %s', (name, contentType, expected) => {
    expect(isImageAttachment({ name, url: 'https://cdn.example.com/x', contentType }, EXT)).toBe(expected);
  });
});

describe('extractFirstLink', () => {
  it.each([
    ['my post https://example.com/p/1 thanks', 'https://example.com/p/1'],
    ['see <https://example.com/a?b=1>', 'https://example.com/a?b=1'],
    ['**https://example.com/bold**', 'https://example.com/bold'],
    ['[my video](https://example.com/watch?v=abc)', 'https://example.com/watch?v=abc'],
    ['link: https://en.example.org/wiki/Thing_(topic).', 'https://en.example.org/wiki/Thing_(topic)'],
    ['two: http://first.example.com and https://second.example.com', 'http://first.example.com'],
    ['HTTPS://EXAMPLE.COM/UP', 'HTTPS://EXAMPLE.COM/UP'],
    ['||https://example.com/spoiler||', 'https://example.com/spoiler'],
    // Masked links record where they point, not what they show.
    ['[https://example.com/p](https://example.com/p)', 'https://example.com/p'],
    ['[https://example.com/a](<https://example.com/a>)', 'https://example.com/a'],
    ['[https://shown.example.com](https://real.example.com/t)', 'https://real.example.com/t'],
    ['see [this](https://en.example.org/wiki/Thing_(topic)).', 'https://en.example.org/wiki/Thing_(topic)'],
    // A trailing underscore is part of the URL unless the link is wrapped in underscores.
    ['https://social.example.com/some_user_', 'https://social.example.com/some_user_'],
    ['__https://example.com/underlined__', 'https://example.com/underlined'],
    ['_https://example.com/italic_', 'https://example.com/italic'],
  ])('%j -> %s', (text, expected) => {
    expect(extractFirstLink(text)).toBe(expected);
  });

  it.each(['no link here', 'example.com without scheme', 'ftp://example.com', 'https:// nothing'])('%j -> none', (text) => {
    expect(extractFirstLink(text)).toBeUndefined();
  });
});

describe('buildSubmissionRow', () => {
  it('fills every column', () => {
    const row = buildSubmissionRow(
      {
        createdAt: new Date('2026-03-04T05:06:07.890Z'),
        authorId: '100000000000000001',
        authorUsername: 'member_a',
        channelName: 'submissions',
        content: 'share post ✅ https://example.com/p',
        url: 'https://discord.com/channels/1/2/3',
      },
      {
        platform: 'discord',
        questType: 'share_post',
        fuzzy: false,
        attachmentUrl: 'https://cdn.example.com/shot.png',
      },
    );
    expect(row).toEqual({
      timestamp_utc: '2026-03-04T05:06:07Z',
      user_id: '100000000000000001',
      username: 'member_a',
      uid: '',
      bound: false,
      quest_type: 'share_post',
      fuzzy_match: false,
      channel_name: 'submissions',
      message_text: 'share post ✅ https://example.com/p',
      attachment_url: 'https://cdn.example.com/shot.png',
      link_url: 'https://example.com/p',
      message_link: 'https://discord.com/channels/1/2/3',
      date_utc: '2026-03-04',
      platform: 'discord',
    });
  });
});
