import { describe, expect, it } from 'vitest';
import config from '../../../electron.vite.config';

// Bundled CommonJS deps (electron-updater) `require('electron')`, which the
// main build resolves to the `\0electron-require-shim` virtual module. Without
// an override, @rollup/plugin-commonjs hands them getAugmentedNamespace(shim) —
// a copy of the shim's NAMED exports only — so `require('electron').autoUpdater`
// was undefined and `new MacUpdater()` crashed on `.on` at boot. 'preferred'
// makes the require return the shim's default export: the real electron object.

function mainRequireReturnsDefault(): (id: string) => unknown {
  const fn = config.main?.build?.commonjsOptions?.requireReturnsDefault;
  if (typeof fn !== 'function') throw new Error('requireReturnsDefault is not a function');
  return fn;
}

describe('electron.vite.config main commonjsOptions.requireReturnsDefault', () => {
  it("returns 'preferred' for the electron require shim", () => {
    expect(mainRequireReturnsDefault()('\0electron-require-shim')).toBe('preferred');
  });

  it('keeps the plugin default (false) for every other id', () => {
    const fn = mainRequireReturnsDefault();
    expect(fn('/repo/node_modules/ws/index.js')).toBe(false);
    expect(fn('\0req:argon2')).toBe(false);
    expect(fn('electron')).toBe(false);
  });
});
