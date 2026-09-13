// P-T14 — `ethos plugin install` and the web install build the grant and the
// lock pin through one helper in @ethosagent/plugin-loader. This pins that the
// CLI does not grow a second copy of either.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function pluginSource(): string {
  return readFileSync(join(import.meta.dirname, '..', 'plugin.ts'), 'utf8');
}

describe('CLI install record goes through the shared helper', () => {
  it('drafts the grant and pins the personality through plugin-loader', () => {
    const src = pluginSource();
    expect(src).toContain('draftPluginGrant({');
    expect(src).toContain('await pinPluginToPersonality({');
  });

  it('assembles no lock entry of its own', () => {
    const src = pluginSource();
    expect(src).not.toContain('computeIntegrity(');
    expect(src).not.toContain('writeLockfile(');
  });
});
