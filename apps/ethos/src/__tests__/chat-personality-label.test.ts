// plan personality-presence-and-initiative §2 — the chat header shows the
// active personality's `display.emoji` beside its name, and nothing extra when
// the emoji is unset or the target is a team.

import type { PersonalityConfig } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { chatPersonalityLabel } from '../lib/personality-label';

function registry(configs: PersonalityConfig[]) {
  const byId = new Map(configs.map((c) => [c.id, c]));
  return { get: (id: string) => byId.get(id) };
}

describe('chatPersonalityLabel', () => {
  it('prefixes the emoji when the personality declares one', () => {
    const r = registry([{ id: 'owl', name: 'Owl', display: { emoji: '🦉' } }]);
    expect(chatPersonalityLabel('owl', r)).toBe('🦉 owl');
  });

  it('is the bare name when no emoji is set (an avatar alone changes nothing here)', () => {
    const r = registry([{ id: 'owl', name: 'Owl', display: { avatar_url: '/a.png' } }]);
    expect(chatPersonalityLabel('owl', r)).toBe('owl');
  });

  it('is the bare label for a team target, which is not a personality id', () => {
    const r = registry([{ id: 'owl', name: 'Owl', display: { emoji: '🦉' } }]);
    expect(chatPersonalityLabel('team:birds', r)).toBe('team:birds');
  });
});
