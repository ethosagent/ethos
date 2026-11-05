// Data-free launcher helpers for a catalog pin. Re-exported by both the
// package root and `@ethosagent/catalog/filter`, so an app (which may import
// support packages but not extensions) can build a pinned argv without
// loading the entry data. Pinned by packages/catalog/src/__tests__/pin.test.ts.

import type { CatalogPin } from '@ethosagent/types';

/** An npm or PyPI pin: the two pin types a launcher can run. */
export type PackagePin = Extract<CatalogPin, { type: 'npm' | 'pypi' }>;

/** The launcher spec for a pin, `name@version`, which npx and uvx both accept. */
export function pinSpec(pin: { package: string; version: string }): string {
  return `${pin.package}@${pin.version}`;
}

/**
 * The launcher argv up to and including the spec. npm: auto-confirm and skip
 * install lifecycle scripts (canary in extensions/tools-mcp/src/presets.ts
 * header). pypi: uvx takes the spec first.
 */
export function launcherArgs(pin: PackagePin): string[] {
  return pin.type === 'npm' ? ['-y', '--ignore-scripts', pinSpec(pin)] : [pinSpec(pin)];
}
