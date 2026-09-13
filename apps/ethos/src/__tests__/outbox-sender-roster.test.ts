// O-T4's roster — `buildBotSpeakers` (plan/phases/trust-before-reach.md).
//
// The botKey-level generalisation of `buildChannelSpeakers`. Two callers depend
// on it answering the same question two ways: the outbox's sender resolver asks
// WHICH bots may publish for a personality, and `Gateway.deliverPublication`
// asks whether ONE still may. A disagreement between them publishes in a voice
// nobody approved, so this file pins that they come from one roster.

import type { EthosConfig } from '@ethosagent/config';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../wiring', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../wiring')>();
  return {
    ...orig,
    loadTeamManifest: (teamName: string) => {
      if (teamName !== 'example-team') throw new Error(`no manifest for ${teamName}`);
      return {
        name: 'example-team',
        members: [{ personality: 'coordinator' }, { personality: 'member-a' }],
      };
    },
  };
});

const { buildBotSpeakers, buildChannelSpeakers } = await import('../commands/gateway');

/** Two telegram bots bound to the same personality, plus a third bound to a
 *  team that personality belongs to. Explicit `id:`s so the botKeys are
 *  readable rather than sha256 of a token. */
function config(): EthosConfig {
  return {
    personality: 'default',
    telegram: {
      bots: [
        { id: 'bot-a', token: 't-a', bind: { type: 'personality', name: 'coordinator' } },
        { id: 'bot-b', token: 't-b', bind: { type: 'personality', name: 'coordinator' } },
        { id: 'bot-support', token: 't-s', bind: { type: 'personality', name: 'support' } },
      ],
    },
    slack: {
      apps: [
        {
          id: 'slack-team',
          botToken: 'xoxb',
          appToken: 'xapp',
          signingSecret: 's',
          bind: { type: 'team', name: 'example-team' },
        },
      ],
    },
  } as unknown as EthosConfig;
}

describe('buildBotSpeakers', () => {
  it('returns every telegram bot bound to the personality, and only those', () => {
    expect(buildBotSpeakers(config()).candidates('telegram', 'coordinator')).toEqual([
      'bot-a',
      'bot-b',
    ]);
  });

  it('resolves a team-bound bot for a member of that team', () => {
    const speakers = buildBotSpeakers(config());
    expect(speakers.candidates('slack', 'coordinator')).toEqual(['slack-team']);
    expect(speakers.speaksFor('slack-team', 'member-a')).toBe(true);
    expect(speakers.speaksFor('slack-team', 'support')).toBe(false);
  });

  it('answers for no bot at all when nothing is bound', () => {
    expect(buildBotSpeakers(config()).candidates('telegram', 'ghost')).toEqual([]);
    expect(buildBotSpeakers(config()).speaksFor('bot-a', 'ghost')).toBe(false);
  });

  it('does not let a bot speak for a personality on another platform', () => {
    // `bot-a` is a Telegram bot; asking about Slack must not find it.
    expect(buildBotSpeakers(config()).candidates('slack', 'support')).toEqual([]);
  });

  it('is the one roster `buildChannelSpeakers` answers from', () => {
    const speakers = buildBotSpeakers(config());
    const channel = buildChannelSpeakers(config());
    for (const [platform, id] of [
      ['telegram', 'coordinator'],
      ['telegram', 'support'],
      ['telegram', 'ghost'],
      ['slack', 'coordinator'],
      ['slack', 'support'],
    ] as const) {
      expect(channel(platform, id)).toBe(speakers.candidates(platform, id).length > 0);
    }
  });
});
