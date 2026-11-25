import { describe, expect, it } from 'vitest';
import { ROOM_BLOCK_MAX_CHARS, ROOM_SILENT_LINE, type RoomPolicyTable } from '../room-policy';
import { RoomLaneNotes, RoomTurnPolicies } from '../room-turn';

const room = { isDm: false } as const;
const text = (c: string, n: number) => c.repeat(n);

describe('RoomTurnPolicies.forTurn whole-block cap', () => {
  const discord = (entries: RoomPolicyTable['discord']['entries']): RoomTurnPolicies =>
    new RoomTurnPolicies({ discord: { entries } });
  const input = { platform: 'discord', chatId: 'P', threadId: 'T', ...room };

  it('Discord 3 layers at 3,000 each: drops the most specific (thread) and fits', () => {
    const p = discord({
      P: { prompt: text('p', 3000) },
      'P.topics.T': { prompt: text('t', 3000) },
      T: { prompt: text('d', 3000) },
    }).forTurn(input, undefined);
    expect(p?.trimmed).toEqual(['T']);
    expect(p?.prompt).toBe(`${text('p', 3000)}\n\n${text('t', 3000)}`);
    expect((p?.prompt ?? '').length).toBeLessThanOrEqual(ROOM_BLOCK_MAX_CHARS);
  });

  it('keeps dropping until it fits', () => {
    const p = discord({
      P: { prompt: text('p', 4000) },
      'P.topics.T': { prompt: text('t', 4000) },
      T: { prompt: text('d', 4000) },
    }).forTurn(input, undefined);
    // 4000 + 2 + 4000 = 8002 > 8000, so topic goes too.
    expect(p?.trimmed).toEqual(['T', 'P.topics.T']);
    expect(p?.prompt).toBe(text('p', 4000));
  });

  it('a wildcard that is not rendered does not count: no over-drop', () => {
    const p = discord({
      '*': { prompt: text('w', 3000) },
      P: { prompt: text('p', 3000) },
      'P.topics.T': { prompt: text('t', 3000) },
    }).forTurn(input, undefined);
    // Layers present, so the wildcard prompt is not used: 3000 + 2 + 3000 fits.
    expect(p?.trimmed).toEqual([]);
    expect(p?.prompt).toBe(`${text('p', 3000)}\n\n${text('t', 3000)}`);
  });

  it('under the cap nothing is dropped and the digest follows the rendered block', () => {
    const p = discord({ P: { prompt: 'short' } }).forTurn(input, undefined);
    expect(p?.trimmed).toEqual([]);
    expect(p?.prompt).toBe('short');
    expect(p?.digest).toMatch(/^[0-9a-f]{8}$/);
  });

  it('a silent room renders the fixed line and the cap counts it', () => {
    const silent = discord({ P: { prompt: 'short', silent: true } }).forTurn(input, undefined);
    expect(silent?.prompt).toBe(`short\n\n${ROOM_SILENT_LINE}`);
    expect(discord({ P: { prompt: 'short' } }).forTurn(input, undefined)?.prompt).toBe('short');
    // 3999 + 2 + 3999 = 8000 fits alone; the silent line pushes it over, so the thread layer drops.
    const entries = {
      P: { prompt: text('p', 3999), silent: true },
      T: { prompt: text('d', 3999) },
    };
    const p = discord(entries).forTurn(input, undefined);
    expect(p?.trimmed).toEqual(['T']);
    expect(p?.prompt).toBe(`${text('p', 3999)}\n\n${ROOM_SILENT_LINE}`);
    expect(
      discord({ ...entries, P: { prompt: text('p', 3999) } }).forTurn(input, undefined)?.trimmed,
    ).toEqual([]);
  });

  it('is pure: the same inputs give the same bytes', () => {
    const t = discord({ P: { prompt: 'x' } });
    expect(t.forTurn(input, undefined)).toEqual(t.forTurn(input, undefined));
  });
});

describe('RoomTurnPolicies enabled / appliesTo', () => {
  it('an empty table is disabled (no per-turn work)', () => {
    expect(new RoomTurnPolicies({}).enabled).toBe(false);
    expect(new RoomTurnPolicies(undefined).enabled).toBe(false);
  });
  it('appliesTo is per platform and own-property only', () => {
    const t = new RoomTurnPolicies({ slack: { entries: {} } });
    expect(t.enabled).toBe(true);
    expect(t.appliesTo('slack')).toBe(true);
    expect(t.appliesTo('telegram')).toBe(false);
    expect(t.appliesTo('constructor')).toBe(false);
  });
});

describe('RoomLaneNotes', () => {
  it('evicts the least recently used session past its bound', () => {
    const n = new RoomLaneNotes(2);
    n.set('a', { isDm: true });
    n.set('b', { isDm: false });
    n.get('a');
    n.set('c', { isDm: true });
    expect(n.get('b')).toBeUndefined();
    expect(n.get('a')).toEqual({ isDm: true });
    expect(n.get('c')).toEqual({ isDm: true });
  });
});
