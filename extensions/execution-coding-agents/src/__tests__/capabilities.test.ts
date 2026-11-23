import { describe, expect, it } from 'vitest';
import { CLAUDE_CODE_ACP_CAPABILITIES } from '../capabilities';

// Pins the comment on `autoResume` in capabilities.ts: the executor never
// requeues a coding-agent run, and Resume is never offered for one.

describe('CLAUDE_CODE_ACP_CAPABILITIES', () => {
  it('declares resume none and no auto-resume', () => {
    expect(CLAUDE_CODE_ACP_CAPABILITIES).toMatchObject({ resume: 'none', autoResume: false });
  });
});
