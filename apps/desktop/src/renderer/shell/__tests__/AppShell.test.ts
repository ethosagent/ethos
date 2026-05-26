import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const shellSource = readFileSync(join(import.meta.dirname, '..', 'AppShell.tsx'), 'utf-8');

describe('AppShell route wiring', () => {
  it('imports PersonalitiesPage', () => {
    expect(shellSource).toContain(
      "import { PersonalitiesPage } from '../personalities/PersonalitiesPage'",
    );
  });

  it('routes personalities before the fallback', () => {
    const personalitiesIndex = shellSource.indexOf("route === 'personalities'");
    const fallbackIndex = shellSource.indexOf('coming soon');
    expect(personalitiesIndex).toBeGreaterThan(-1);
    expect(fallbackIndex).toBeGreaterThan(-1);
    expect(personalitiesIndex).toBeLessThan(fallbackIndex);
  });
});
