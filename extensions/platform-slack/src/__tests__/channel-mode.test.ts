import { describe, expect, it } from 'vitest';
import { shouldRespond } from '../routing/channel-mode';

describe('shouldRespond', () => {
  it('always responds in DMs', () => {
    expect(
      shouldRespond({
        isDm: true,
        isGroupMention: false,
        channelMode: 'mention_only',
        hasBotPosted: false,
      }),
    ).toBe(true);
  });

  it('mention_only ignores plain channel posts', () => {
    expect(
      shouldRespond({
        isDm: false,
        isGroupMention: false,
        channelMode: 'mention_only',
        hasBotPosted: false,
      }),
    ).toBe(false);
  });

  it('mention_only responds to @mentions', () => {
    expect(
      shouldRespond({
        isDm: false,
        isGroupMention: true,
        channelMode: 'mention_only',
        hasBotPosted: false,
      }),
    ).toBe(true);
  });

  it('thread_follow without prior bot post acts like mention_only', () => {
    expect(
      shouldRespond({
        isDm: false,
        isGroupMention: false,
        channelMode: 'thread_follow',
        hasBotPosted: false,
      }),
    ).toBe(false);
  });

  it('thread_follow with prior bot post responds', () => {
    expect(
      shouldRespond({
        isDm: false,
        isGroupMention: false,
        channelMode: 'thread_follow',
        hasBotPosted: true,
      }),
    ).toBe(true);
  });

  it('all responds to every channel post', () => {
    expect(
      shouldRespond({
        isDm: false,
        isGroupMention: false,
        channelMode: 'all',
        hasBotPosted: false,
      }),
    ).toBe(true);
  });
});
