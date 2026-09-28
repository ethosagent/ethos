import type { AmendmentReviewView } from '@ethosagent/web-contracts';
import { AmendmentStatusSchema } from '@ethosagent/web-contracts';
import { describe, expect, it } from 'vitest';
import { AMENDMENT_STATUS_WORDS, cliCommands, diffKind, opsLabel } from '../amendments';

function review(over: Partial<AmendmentReviewView> = {}, status = 'pending' as const) {
  return {
    record: { id: 'a-1', status, ops: [] },
    stale: false,
    expectedAfterHash: 'e',
    ...over,
  } as unknown as AmendmentReviewView;
}

describe('amendments lib', () => {
  it('every wire status has a word', () => {
    for (const s of AmendmentStatusSchema.options) expect(AMENDMENT_STATUS_WORDS[s]).toBeTruthy();
  });

  it('opsLabel and diffKind', () => {
    expect(
      opsLabel({
        ops: [
          { op: 'add_tool', tool: 'web_fetch' },
          { op: 'remove_tool', tool: 'terminal' },
        ],
      }),
    ).toBe('+ web_fetch, - terminal');
    expect([diffKind('+x'), diffKind('-x'), diffKind(' x')]).toEqual(['add', 'del', 'same']);
  });

  it('names the CLI apply command only for an appliable pending amendment', () => {
    expect(cliCommands(review()).map((c) => c.command)).toEqual([
      'ethos personality amendments apply a-1',
      'ethos personality amendments decline a-1 --reason "<why>"',
    ]);
    expect(cliCommands(review({ stale: true })).map((c) => c.label)).toEqual(['Decline']);
    expect(cliCommands(review({ expectedAfterHash: null })).map((c) => c.label)).toEqual([
      'Decline',
    ]);
  });
});
