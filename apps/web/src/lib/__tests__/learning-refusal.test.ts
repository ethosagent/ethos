import { describe, expect, it } from 'vitest';
import { learningRefusal } from '../learning-refusal';

// Plan skill-history-and-lock: the web approve surfaces the `locked` refusal
// (`apps/web-api/src/rpc/learning.ts` -> `LOCKED`, 409) as a readable headline that
// says where to unlock, with the server's own reason (which names the CLI verb) beside it.
describe('learningRefusal', () => {
  it('names a locked skill and where to unlock it', () => {
    const err = Object.assign(
      new Error(
        'cite-sources is locked — unlock it on the Skills page or with `ethos skills unlock cite-sources`',
      ),
      { code: 'LOCKED' },
    );
    const refusal = learningRefusal(err, 'Approve failed');
    expect(refusal.code).toBe('LOCKED');
    expect(refusal.title).toContain('this skill is locked');
    expect(refusal.title).toContain('Skills page');
    expect(refusal.detail).toContain('ethos skills unlock cite-sources');
  });

  it('falls back to the caller title for a code it does not name', () => {
    expect(
      learningRefusal(Object.assign(new Error('x'), { code: 'NOPE' }), 'Approve failed').title,
    ).toBe('Approve failed');
  });
});
