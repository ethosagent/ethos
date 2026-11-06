// `installPlugin` in catalog mode (commands/plugin.ts) THROWS typed EthosErrors
// instead of printing and calling process.exit, and in --json mode keeps stdout
// clean and never prompts. npm is a fake `spawnSync` that lays out the scan
// prefix; the home and state dirs are temp dirs.

import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { home, fake } = vi.hoisted(() => ({
  home: { dir: '' },
  fake: { source: 'export async function activate() {}\n', tarball: 'bytes' },
}));

vi.mock('node:os', async (orig) => ({
  ...(await orig<typeof import('node:os')>()),
  homedir: () => home.dir,
}));
vi.mock('../wiring', async () => {
  const { FsStorage } = await import('@ethosagent/storage-fs');
  return { getStorage: () => new FsStorage(), recordInstallScan: () => undefined };
});
vi.mock('node:child_process', async (orig) => ({
  ...(await orig<typeof import('node:child_process')>()),
  // Only the scan-prefix `npm install --prefix <tmp> <spec>` is faked.
  spawnSync: (_cmd: string, args: string[]) => {
    const prefix = args[args.indexOf('--prefix') + 1] as string;
    const pkgDir = join(prefix, 'node_modules', 'ethos-plugin-demo');
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(
      join(prefix, 'package.json'),
      JSON.stringify({ dependencies: { 'ethos-plugin-demo': '1.2.3' } }),
    );
    writeFileSync(
      join(pkgDir, 'package.json'),
      JSON.stringify({
        name: 'ethos-plugin-demo',
        version: '1.2.3',
        ethos: { type: 'plugin', pluginContractMajor: 4 },
      }),
    );
    writeFileSync(join(pkgDir, 'index.js'), fake.source);
    const sri = `sha512-${createHash('sha512').update(fake.tarball).digest('base64')}`;
    writeFileSync(
      join(prefix, 'package-lock.json'),
      JSON.stringify({ packages: { 'node_modules/ethos-plugin-demo': { integrity: sri } } }),
    );
    return { status: 0, stderr: '' };
  },
}));

import { installPlugin } from '../commands/plugin';

const sriOf = (s: string) => `sha512-${createHash('sha512').update(s).digest('base64')}`;
const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

beforeEach(() => {
  home.dir = mkdtempSync(join(tmpdir(), 'ethos-home-'));
  process.env.ETHOS_STATE_DIR = home.dir;
  fake.source = 'export async function activate() {}\n';
  fake.tarball = 'bytes';
  exit.mockClear();
});
afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(process.env, 'ETHOS_STATE_DIR');
});

async function fails(p: Promise<unknown>): Promise<{ code: string; cause: string }> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  return err as { code: string; cause: string };
}

describe('installPlugin with catalog options', () => {
  it('an integrity different from the catalog pin throws PLUGIN_INTEGRITY_MISMATCH, not exit', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const err = await fails(
      installPlugin('ethos-plugin-demo@1.2.3', undefined, true, {
        integrity: sriOf('other'),
        tier: 'verified',
      }),
    );
    expect(err.code).toBe('PLUGIN_INTEGRITY_MISMATCH');
    expect(exit).not.toHaveBeenCalled();
  });

  it('a red finding throws CATALOG_SCAN_BLOCKED, not exit', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    fake.source = "eval('1');\n";
    const err = await fails(
      installPlugin('ethos-plugin-demo@1.2.3', undefined, true, {
        integrity: sriOf('bytes'),
        tier: 'verified',
      }),
    );
    expect(err.code).toBe('CATALOG_SCAN_BLOCKED');
    expect(exit).not.toHaveBeenCalled();
  });

  it('--json without --yes refuses to prompt, and stdout stays clean while stderr gets the progress', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const errLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const realLog = console.log;
    const err = await fails(
      installPlugin('ethos-plugin-demo@1.2.3', undefined, false, {
        integrity: sriOf('bytes'),
        tier: 'verified',
        json: true,
      }),
    );
    expect(err.code).toBe('PLUGIN_INSTALL_FAILED');
    expect(err.cause).toContain('stdin is not a TTY');
    expect(log).not.toHaveBeenCalled();
    expect(errLog).toHaveBeenCalled();
    expect(console.log).toBe(realLog);
    expect(exit).not.toHaveBeenCalled();
  });
});
