import { describe, expect, it } from 'vitest';
import { launcherArgs as filterLauncherArgs, pinSpec as filterPinSpec } from '../filter';
import { launcherArgs, pinSpec } from '../index';

describe('pin helpers', () => {
  it('pinSpec joins package and version', () => {
    expect(pinSpec({ package: '@a/b', version: '1.2.3' })).toBe('@a/b@1.2.3');
  });

  it('npm launches with -y --ignore-scripts then the spec', () => {
    const pin = { type: 'npm', package: '@a/b', version: '1.2.3', integrity: 'x' } as const;
    expect(launcherArgs(pin)).toEqual(['-y', '--ignore-scripts', '@a/b@1.2.3']);
  });

  it('pypi launches with the spec alone', () => {
    const pin = { type: 'pypi', package: 'mcp-x', version: '2026.1.1', integrity: 'x' } as const;
    expect(launcherArgs(pin)).toEqual(['mcp-x@2026.1.1']);
  });

  it('the data-free ./filter subpath re-exports the same helpers', () => {
    expect(filterPinSpec).toBe(pinSpec);
    expect(filterLauncherArgs).toBe(launcherArgs);
  });
});
