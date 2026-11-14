import { describe, expect, it } from 'vitest';
import { parseRewindArg, REWIND_USAGE } from '../rewind';

describe('parseRewindArg', () => {
  it('defaults to 1 for an empty argument', () => {
    expect(parseRewindArg('')).toEqual({ ok: true, turnsBack: 1 });
    expect(parseRewindArg('  ')).toEqual({ ok: true, turnsBack: 1 });
  });

  it('parses a positive integer', () => {
    expect(parseRewindArg('3')).toEqual({ ok: true, turnsBack: 3 });
  });

  it.each(['0', '-1', 'x', '1.5'])('rejects %j with the usage line', (arg) => {
    expect(parseRewindArg(arg)).toEqual({ ok: false, message: REWIND_USAGE });
  });
});
