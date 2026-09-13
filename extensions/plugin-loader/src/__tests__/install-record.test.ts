// The install record — the grant draft and the `plugins.lock` pin — is built
// in one place and shared by the CLI and web install surfaces. These tests pin
// what it produces, including the FU-1 meaning of `integrity`.

import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FsStorage } from '@ethosagent/storage-fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PluginGrantScan } from '../grants';
import { draftPluginGrant, pinPluginToPersonality } from '../install-record';
import { DEFAULT_REGISTRY, readLockfile } from '../lockfile';

const scan: PluginGrantScan = { tier: 'community', findings: [], hasRed: false, hasYellow: false };

describe('draftPluginGrant', () => {
  it('pins the resolved name@version and keys the grant by the loader id', () => {
    const { draft, exactSpec } = draftPluginGrant({
      pkgJson: {
        name: '@ethos-plugins/tools-zerodha',
        version: '1.4.2',
        ethos: { id: 'zerodha', permissions: { shell: true, network: ['api.kite.trade', 7] } },
      },
      requestedSpec: '@ethos-plugins/tools-zerodha@^1',
      scan,
    });
    expect(exactSpec).toBe('@ethos-plugins/tools-zerodha@1.4.2');
    expect(draft).toEqual({
      id: 'zerodha',
      package: '@ethos-plugins/tools-zerodha',
      version: '1.4.2',
      source: 'npm:@ethos-plugins/tools-zerodha@1.4.2',
      capabilities: { shell: true, network: ['api.kite.trade'] },
      scan,
    });
  });

  it('reads network: true as "any host" and no declaration as null', () => {
    const anyHost = draftPluginGrant({
      pkgJson: { name: 'p', version: '1.0.0', ethos: { permissions: { network: true } } },
      requestedSpec: 'p',
      scan,
    });
    expect(anyHost.draft.capabilities).toEqual({ shell: false, network: [] });

    const none = draftPluginGrant({
      pkgJson: { name: 'p', version: '1.0.0' },
      requestedSpec: 'p',
      scan,
    });
    expect(none.draft.capabilities).toEqual({ shell: false, network: null });
  });

  it('falls back to the requested spec when package.json is unreadable', () => {
    const { draft, exactSpec } = draftPluginGrant({
      pkgJson: undefined,
      requestedSpec: '@scope/ethos-plugin-foo',
      scan,
    });
    expect(exactSpec).toBe('@scope/ethos-plugin-foo');
    expect(draft).toMatchObject({
      id: 'ethos-plugin-foo',
      package: '@scope/ethos-plugin-foo',
      version: 'unknown',
      source: 'npm:@scope/ethos-plugin-foo',
      capabilities: { shell: false, network: null },
    });
  });
});

describe('pinPluginToPersonality', () => {
  let root: string;

  beforeEach(async () => {
    root = join(
      tmpdir(),
      `ethos-install-record-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await mkdir(root, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('writes a lock entry whose integrity is the sha512 SRI of the npm tarball, not of package.json, and lists the plugin', async () => {
    const storage = new FsStorage();
    const pkgJson = JSON.stringify({ name: '@ethos-plugins/demo', version: '2.0.1' });
    const tarball = Buffer.from('the published tarball bytes');
    const sri = (bytes: string | Buffer) =>
      `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
    const personalityDir = join(root, 'personalities', 'researcher');
    await mkdir(personalityDir, { recursive: true });
    await writeFile(join(personalityDir, 'config.yaml'), 'name: researcher\n');

    const npmCalls: string[][] = [];
    const runNpm = async (args: string[]) => {
      npmCalls.push(args);
      const dest = args[args.indexOf('--pack-destination') + 1] ?? '';
      writeFileSync(join(dest, 'ethos-plugins-demo-2.0.1.tgz'), tarball);
    };

    const { draft } = draftPluginGrant({
      pkgJson: JSON.parse(pkgJson),
      requestedSpec: '@ethos-plugins/demo',
      scan,
    });
    const entry = await pinPluginToPersonality({ storage, personalityDir, draft, runNpm });

    expect(entry).toEqual({
      package: '@ethos-plugins/demo',
      version: '2.0.1',
      registry: DEFAULT_REGISTRY,
      integrity: sri(tarball),
      integrityOf: 'tarball',
    });
    expect(entry.integrity).not.toBe(sri(pkgJson));
    expect(npmCalls).toEqual([
      [
        'pack',
        '@ethos-plugins/demo@2.0.1',
        '--pack-destination',
        expect.stringContaining('ethos-plugin-pack-'),
        '--ignore-scripts',
      ],
    ]);
    // readLockfile validates every entry; surviving it means the pin is well-formed.
    expect((await readLockfile(storage, personalityDir)).demo).toEqual(entry);
    expect(await storage.read(join(personalityDir, 'config.yaml'))).toContain('plugins: demo');
  });
});
