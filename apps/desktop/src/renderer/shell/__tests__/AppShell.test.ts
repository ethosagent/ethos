import { existsSync, readFileSync } from 'node:fs';
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

  // --- Phase 12 lab screens ---

  const labScreens = [
    { component: 'BatchPage', route: 'batch-eval', importPath: '../lab/batch/BatchPage' },
    { component: 'KanbanPage', route: 'kanban', importPath: '../lab/kanban/KanbanPage' },
    { component: 'ObservabilityPage', route: 'observability', importPath: '../lab/observability/ObservabilityPage' },
    { component: 'MeshPage', route: 'mesh', importPath: '../lab/mesh/MeshPage' },
    { component: 'ApiKeysPage', route: 'api-keys', importPath: '../lab/api-keys/ApiKeysPage' },
  ] as const;

  for (const { component, route, importPath } of labScreens) {
    it(`imports ${component}`, () => {
      expect(shellSource).toContain(
        `import { ${component} } from '${importPath}'`,
      );
    });

    it(`routes ${route} before the fallback`, () => {
      const routeIndex = shellSource.indexOf(`route === '${route}'`);
      const fallbackIndex = shellSource.indexOf('coming soon');
      expect(routeIndex).toBeGreaterThan(-1);
      expect(fallbackIndex).toBeGreaterThan(-1);
      expect(routeIndex).toBeLessThan(fallbackIndex);
    });

    it(`wraps ${component} in an ErrorBoundary`, () => {
      expect(shellSource).toContain(`<ErrorBoundary label="${component}">`);
    });
  }
});

describe('UI component files exist', () => {
  it('SparklineChart component exists', () => {
    expect(existsSync(join(import.meta.dirname, '..', '..', 'ui', 'SparklineChart.tsx'))).toBe(true);
  });

  it('ProgressBar component exists', () => {
    expect(existsSync(join(import.meta.dirname, '..', '..', 'ui', 'ProgressBar.tsx'))).toBe(true);
  });
});
