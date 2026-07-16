import { describe, expect, it } from 'vitest';
import { parseFacts } from '../extraction';

describe('parseFacts', () => {
  it('returns [] for chit-chat (NONE)', () => {
    expect(parseFacts('NONE')).toEqual([]);
    expect(parseFacts('none.')).toEqual([]);
    expect(parseFacts('   ')).toEqual([]);
  });

  it('parses well-formed pipe lines', () => {
    const facts = parseFacts(
      'USER|0.8|Has a daughter named Priya.\nMEMORY|0.5|Q3 launch mid-Sept.',
    );
    expect(facts).toEqual([
      { store: 'user', text: 'Has a daughter named Priya.', hint: 0.8 },
      { store: 'memory', text: 'Q3 launch mid-Sept.', hint: 0.5 },
    ]);
  });

  it('drops malformed lines but keeps valid ones', () => {
    const facts = parseFacts('garbage line\nUSER|0.3|Likes tea\nOTHER|0.9|bad store');
    expect(facts).toEqual([{ store: 'user', text: 'Likes tea', hint: 0.3 }]);
  });

  it('clamps importance into [0,1]', () => {
    const facts = parseFacts('USER|9|too high\nMEMORY|-1|too low');
    expect(facts.map((f) => f.hint)).toEqual([1, 0]);
  });

  it('preserves pipes inside the fact text', () => {
    const facts = parseFacts('MEMORY|0.5|uses a|b|c pipeline');
    expect(facts).toEqual([{ store: 'memory', text: 'uses a|b|c pipeline', hint: 0.5 }]);
  });

  it('drops lines with non-numeric importance', () => {
    expect(parseFacts('USER|high|nope')).toEqual([]);
  });
});
