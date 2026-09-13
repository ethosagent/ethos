// One parser of `ethos.permissions`.
//
// `ethos plugin install` reads a package's declared permissions twice: once to
// scan the code before install (`walkAndScan`), once to draft the capability
// grant (`draftPluginGrant`). The scan used to carry a private copy of the
// parser. Two parsers of one format drift, and a drift here means the scan
// judges code against permissions the grant never recorded. Both now go through
// `readPluginPermissions` in `extensions/plugin-loader/src/install-record.ts`.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readPluginPermissions } from '@ethosagent/plugin-loader';
import { describe, expect, it } from 'vitest';

function pluginSource(): string {
  return readFileSync(join(import.meta.dirname, '..', 'plugin.ts'), 'utf8');
}

describe('CLI pre-install scan permissions', () => {
  it('imports readPluginPermissions from @ethosagent/plugin-loader', () => {
    const src = pluginSource();
    const importBlock = src.match(/import \{([^}]*)\} from '@ethosagent\/plugin-loader';/);
    expect(importBlock?.[1]).toMatch(/\breadPluginPermissions\b/);
  });

  it('feeds the pre-install scan from that parser', () => {
    expect(pluginSource()).toContain(
      'const permissions = readPluginPermissions(await readPackageJson(pkgDir));',
    );
  });

  it('defines no private parser of ethos.permissions', () => {
    const src = pluginSource();
    expect(src).not.toMatch(/function readPluginPermissions\b/);
    // The private copy's signature access: `(ethos as Record<string, unknown>).permissions`.
    expect(src).not.toMatch(/\)\.permissions\b/);
  });
});

describe('readPluginPermissions — the shapes the scan relies on', () => {
  const pkg = (permissions: unknown) => ({ name: 'p', ethos: { permissions } });

  it('network: true is any host', () => {
    expect(readPluginPermissions(pkg({ network: true }))).toEqual({ network: [] });
  });

  it('a host array keeps only string hosts', () => {
    expect(readPluginPermissions(pkg({ network: ['a.example', 5, 'b.example'] }))).toEqual({
      network: ['a.example', 'b.example'],
    });
  });

  it('absent permissions declare nothing', () => {
    expect(readPluginPermissions({ name: 'p' })).toEqual({});
    expect(readPluginPermissions(undefined)).toEqual({});
  });

  it('a non-boolean shell is not shell access', () => {
    expect(readPluginPermissions(pkg({ shell: 'yes' }))).toEqual({});
    expect(readPluginPermissions(pkg({ shell: true }))).toEqual({ shell: true });
  });
});
