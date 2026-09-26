import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('package.json contract', () => {
  it('has only @ethosagent/* workspace dependencies (plan success criterion 1)', () => {
    const raw = readFileSync(new URL('../../package.json', import.meta.url), 'utf8');
    const pkg = JSON.parse(raw) as { dependencies?: Record<string, string> };
    const deps = Object.keys(pkg.dependencies ?? {});
    expect(deps.length).toBeGreaterThan(0);
    for (const dep of deps) {
      expect(dep).toMatch(/^@ethosagent\//);
    }
  });
});
