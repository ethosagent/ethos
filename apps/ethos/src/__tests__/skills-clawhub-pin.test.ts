// The `npx` fallback of `ethos skills install` names an exact, reviewed clawhub
// version (unified-catalog §6.5), never a dist-tag.

import { describe, expect, it } from 'vitest';
import { CLAWHUB_VERSION, clawhubNpxArgs } from '../commands/skills';

describe('clawhub version pin', () => {
  it('CLAWHUB_VERSION is exact semver', () => {
    expect(CLAWHUB_VERSION).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  });

  it('the npx argv is clawhub@<CLAWHUB_VERSION> followed by the arguments, with no @latest', () => {
    const argv = clawhubNpxArgs(['install', '--workdir', '/w', 'owner/slug']);
    expect(argv).toEqual([
      `clawhub@${CLAWHUB_VERSION}`,
      'install',
      '--workdir',
      '/w',
      'owner/slug',
    ]);
    expect(argv.join(' ')).not.toContain('@latest');
  });
});
