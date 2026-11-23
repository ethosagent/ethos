import { describe, expect, it } from 'vitest';
import { ETHOS_RUNNER_CAPABILITIES } from '../index';

// Pins `ETHOS_RUNNER_CAPABILITIES`' resume claims (cited by the comment on the
// constant): a resumed Ethos run continues the child session, so it is the one
// built-in runner that auto-resumes.

describe('ETHOS_RUNNER_CAPABILITIES', () => {
  it('resumes by session and auto-resumes', () => {
    expect(ETHOS_RUNNER_CAPABILITIES).toMatchObject({ resume: 'session', autoResume: true });
  });
});
