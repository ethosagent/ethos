import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { contract, PersonalitySchema } from '../index';

// plan personality-presence-and-initiative §2 — `display.emoji` rides the
// `display` block on the wire both ways. Object schemas STRIP unknown keys, so
// a sub-key missing from a schema would vanish silently; these pin it present.

function schemaOf(procedure: unknown, field: 'inputSchema' | 'outputSchema'): z.ZodType {
  const def = (procedure as { '~orpc'?: Record<string, unknown> })['~orpc'];
  const schema = def?.[field];
  if (!(schema instanceof z.ZodType)) throw new Error(`contract has no ${field}`);
  return schema;
}

const update = schemaOf(contract.personalities.update, 'inputSchema');

describe('personalities.update — display input', () => {
  it('carries emoji beside avatar_url', () => {
    const parsed = update.parse({ id: 'p', display: { emoji: '🦉', avatar_url: '/a.png' } });
    expect(parsed).toMatchObject({ display: { emoji: '🦉', avatar_url: '/a.png' } });
  });

  it("accepts '' to clear the emoji", () => {
    expect(update.safeParse({ id: 'p', display: { emoji: '' } }).success).toBe(true);
  });

  it.each(['🦉🦉', 'ab', 'x'.repeat(200)])('refuses %s', (emoji) => {
    expect(update.safeParse({ id: 'p', display: { emoji } }).success).toBe(false);
  });
});

describe('Personality — display output', () => {
  it('round-trips emoji', () => {
    const display = { emoji: '🦉', avatar_url: '/a.png' };
    expect(PersonalitySchema.shape.display.parse(display)).toEqual(display);
  });
});
