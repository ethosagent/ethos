// Plan plugin-process-isolation §9.2 and §5.8: `plugins.host.sandbox: auto`.
// The OS tests run for real where the wrapper exists (`sandbox-exec` on macOS,
// `bwrap` on Linux). This is a deny-list profile over allow-default, NOT a
// sandbox guarantee (D7); the assertions below are what the profile does today.

import { cp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { defaultAlwaysDeny, FsStorage, ScopedStorage } from '@ethosagent/storage-fs';
import type { ToolContext } from '@ethosagent/types';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createPluginActivator } from '../activator';
import { HOST_ERROR } from '../errors';
import { requestFromContext } from '../proxies/request';
import {
  bwrapArgs,
  deniedPaths,
  detectSandbox,
  readOnlyDirs,
  sbplString,
  seatbeltProfile,
} from '../sandbox';
import { fixtureDir, type Harness, makeCtx, makeHarness } from './helpers/harness';

const SLOW = 40_000;
const VAULT_VALUE = 'vault-file-value-do-not-leak';

const detected = await detectSandbox();
const seatbeltAvailable = process.platform === 'darwin' && detected.kind === 'seatbelt';
const bwrapAvailable = process.platform === 'linux' && detected.kind === 'bwrap';

let h: Harness | undefined;
let extra: string[] = [];
let server: Server | undefined;
let port = 0;

beforeAll(async () => {
  server = createServer((socket) => socket.end());
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  port = typeof address === 'object' && address ? address.port : 0;
});

afterAll(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
});

afterEach(async () => {
  await h?.cleanup();
  h = undefined;
  await Promise.all(extra.map((p) => rm(p, { recursive: true, force: true })));
  extra = [];
});

interface Out {
  ok: boolean;
  value?: unknown;
  code?: string | null;
  error?: string;
}

async function probe(
  h0: Harness,
  lease: Awaited<ReturnType<Harness['pool']['acquire']>>,
  action: string,
  arg?: string,
): Promise<Out> {
  const ctx: ToolContext = {
    ...makeCtx(),
    storage: new ScopedStorage(new FsStorage(), {
      read: [join(h0.dataDir, 'work')],
      write: [join(h0.dataDir, 'work')],
      alwaysDeny: defaultAlwaysDeny([h0.dataDir]),
    }),
    scopedFetch: { fetch: async () => new Response('fetched-through-parent') },
  };
  const result = await lease.callTool(requestFromContext('sbx_probe', { action, arg }, ctx), ctx);
  if (!result.ok) throw new Error(`sbx_probe ${action}: ${result.error}`);
  return JSON.parse(result.value) as Out;
}

async function seedState(h0: Harness): Promise<string> {
  const vaultFile = join(h0.dataDir, 'secrets', 'providers', 'anthropic', 'apiKey');
  await mkdir(join(h0.dataDir, 'secrets', 'providers', 'anthropic'), { recursive: true });
  await writeFile(vaultFile, VAULT_VALUE);
  await mkdir(join(h0.dataDir, 'work'), { recursive: true });
  await writeFile(join(h0.dataDir, 'work', 'note.txt'), 'storage-still-works');
  return vaultFile;
}

/** §9.2 first clause, shared by the macOS and Linux variants. */
async function sandboxedScenario(): Promise<void> {
  h = await makeHarness({ sandbox: 'auto' });
  const vaultFile = await seedState(h);
  const lease = await h.pool.acquire({ id: 'sbx', dir: fixtureDir('sandboxed'), network: null });
  const hostHome = join(h.dataDir, 'plugin-hosts', 'sbx', 'home');

  // The raw vault read fails (EPERM under Seatbelt; bwrap's tmpfs makes the file ENOENT).
  const raw = await probe(h, lease, 'raw_read', vaultFile);
  expect(raw.ok).toBe(false);
  expect(raw.code).toMatch(process.platform === 'darwin' ? /^EPERM$/ : /^(EPERM|ENOENT|EACCES)$/);
  expect(JSON.stringify(raw)).not.toContain(VAULT_VALUE);

  // The host's own HOME is writable, and its package dir is readable.
  expect((await probe(h, lease, 'write_home')).value).toBe('hello');
  expect((await probe(h, lease, 'read_pkg')).value).toBe('fixture-sandboxed');
  expect(hostHome).toContain('plugin-hosts');

  // The package dir is read-only (the fixture lives outside the state dir here; see the next test for the inside case).
  // ctx.storage is IPC to the parent, so it still reaches what the call's scope allows.
  expect((await probe(h, lease, 'storage_read', join(h.dataDir, 'work', 'note.txt'))).value).toBe(
    'storage-still-works',
  );
}

describe('plugins.host.sandbox: auto', () => {
  it.skipIf(!seatbeltAvailable)(
    'under sandbox-exec the raw vault read fails with EPERM, the host own HOME is writable, the package dir is readable, and ctx.storage still works',
    sandboxedScenario,
    SLOW,
  );

  it.skipIf(!bwrapAvailable)(
    'under bwrap the raw vault read fails, the host own HOME is writable, the package dir is readable, and ctx.storage still works',
    sandboxedScenario,
    SLOW,
  );

  it.skipIf(!seatbeltAvailable)(
    'a package under the denied state dir still loads, and stays read-only (Seatbelt: file-read-data, not file-read*)',
    async () => {
      h = await makeHarness({ sandbox: 'auto' });
      // An installed plugin lives under <dataDir>/plugins/node_modules/<pkg>: inside the denied dir.
      const installed = join(h.dataDir, 'plugins', 'node_modules', 'fixture-sandboxed');
      await mkdir(installed, { recursive: true });
      await cp(fixtureDir('sandboxed'), installed, { recursive: true });
      await seedState(h);
      const lease = await h.pool.acquire({ id: 'sbx-installed', dir: installed, network: null });
      expect((await probe(h, lease, 'read_pkg')).value).toBe('fixture-sandboxed');
      const planted = await probe(h, lease, 'write_pkg');
      expect(planted.ok).toBe(false);
      expect(planted.code).toBe('EPERM');
      expect((await readdir(installed)).includes('planted.txt')).toBe(false);
    },
    SLOW,
  );

  it.skipIf(!seatbeltAvailable && !bwrapAvailable)(
    'network: null grant -> an outbound connect fails; ctx.scopedFetch to an allowed host succeeds through the parent',
    async () => {
      h = await makeHarness({ sandbox: 'auto' });
      await seedState(h);
      const lease = await h.pool.acquire({
        id: 'sbx-net',
        dir: fixtureDir('sandboxed'),
        network: null,
      });
      const connect = await probe(h, lease, 'net_connect', String(port));
      expect(connect.ok).toBe(false);
      expect(connect.code).toMatch(/^(EPERM|ECONNREFUSED|ENETUNREACH|EACCES)$/);
      expect((await probe(h, lease, 'scoped_fetch')).value).toBe('fetched-through-parent');
    },
    SLOW,
  );

  it.skipIf(!seatbeltAvailable && !bwrapAvailable)(
    'LIMITATION (D16) - a grant that declares a host list leaves the network open: a connect succeeds',
    async () => {
      // Seatbelt and bwrap cannot filter by hostname, so "declared hosts" means "all of the network".
      h = await makeHarness({ sandbox: 'auto' });
      await seedState(h);
      const lease = await h.pool.acquire({
        id: 'sbx-open',
        dir: fixtureDir('sandboxed'),
        network: ['allowed.test'],
      });
      expect((await probe(h, lease, 'net_connect', String(port))).ok).toBe(true);
    },
    SLOW,
  );

  it(
    'LIMITATION - sandbox: none leaves the same files readable (the D6 pin, here beside its sandboxed twin)',
    async () => {
      h = await makeHarness({ sandbox: 'none' });
      const vaultFile = await seedState(h);
      const lease = await h.pool.acquire({ id: 'sbx-off', dir: fixtureDir('sandboxed') });
      expect((await probe(h, lease, 'raw_read', vaultFile)).value).toBe(VAULT_VALUE);
    },
    SLOW,
  );

  it(
    'auto with no wrapper -> PLUGIN_HOST_SANDBOX_UNAVAILABLE and nothing is spawned or imported',
    async () => {
      h = await makeHarness({ sandbox: 'auto', sandboxPlatform: 'win32' });
      await expect(
        createPluginActivator(h.pool).activate({
          id: 'echo',
          dir: fixtureDir('echo'),
          entry: '',
          manifest: {},
          tier: 'untrusted',
        }),
      ).rejects.toThrow(HOST_ERROR.sandboxUnavailable);
      expect(h.pool.pidOf('echo')).toBeUndefined();
      // The echo fixture appends to $HOME/activations.log when imported; the host home was never even created.
      expect(await readdir(h.dataDir)).not.toContain('plugin-hosts');
      expect(
        h.events.some((e) => e.category === 'plugin_host.denied' && e.payload.kind === 'sandbox'),
      ).toBe(true);
    },
    SLOW,
  );

  it(
    'a wrapper that is installed but refuses to start (probe fails) also fails closed, never unsandboxed',
    async () => {
      h = await makeHarness({
        sandbox: 'auto',
        sandboxPlatform: 'darwin',
        sandboxProbe: async () => false,
      });
      await expect(h.pool.acquire({ id: 'echo', dir: fixtureDir('echo') })).rejects.toThrow(
        HOST_ERROR.sandboxUnavailable,
      );
      expect(await readdir(h.dataDir)).not.toContain('plugin-hosts');
    },
    SLOW,
  );

  it('detectSandbox: darwin and linux run a probe, anything else is unavailable', async () => {
    const seen: string[] = [];
    const probeOk = async (command: string): Promise<boolean> => {
      seen.push(command);
      return true;
    };
    expect(await detectSandbox('darwin', probeOk)).toEqual({
      kind: 'seatbelt',
      command: '/usr/bin/sandbox-exec',
    });
    expect(await detectSandbox('linux', probeOk)).toEqual({ kind: 'bwrap', command: 'bwrap' });
    expect((await detectSandbox('linux', async () => false)).kind).toBe('unavailable');
    expect((await detectSandbox('win32', probeOk)).kind).toBe('unavailable');
    expect(seen).toEqual(['/usr/bin/sandbox-exec', 'bwrap']);
  });
});

describe('Seatbelt profile shape', () => {
  const spec = {
    dataDir: '/var/folders/x/data',
    hostDir: '/var/folders/x/data/plugin-hosts/p',
    pluginDir: '/var/folders/x/data/plugins/node_modules/pkg',
    network: null,
    homeDir: '/Users/u',
    denyPaths: ['/Users/u/.ssh', '/Users/u/.ethos/secrets'],
  } as const;

  it('orders deny before allow (last match wins), covers /private forms, and denies network for network: null', () => {
    const lines = seatbeltProfile(spec).split('\n');
    expect(lines[0]).toBe('(version 1)');
    expect(lines[1]).toBe('(allow default)');
    const at = (needle: string): number => lines.findIndex((l) => l.includes(needle));
    expect(lines[2]).toBe(
      '(deny file-read-data file-write* (subpath "/var/folders/x/data") (subpath "/private/var/folders/x/data"))',
    );
    expect(at('(subpath "/Users/u/.ssh")')).toBeGreaterThan(2);
    expect(at('(subpath "/Users/u/.aws")')).toBeGreaterThan(2);
    expect(at('(subpath "/Users/u/.config/gcloud")')).toBeGreaterThan(2);
    expect(at('(subpath "/Users/u/.npmrc")')).toBeGreaterThan(2);
    expect(at('(subpath "/Users/u/.netrc")')).toBeGreaterThan(2);
    expect(at('(subpath "/Users/u/Library/Keychains")')).toBeGreaterThan(2);
    const denyAll = Math.max(
      ...lines.map((l, i) => (l.startsWith('(deny file-read-data') ? i : -1)),
    );
    const allowHost = lines.findIndex((l) => l.startsWith('(allow file-read-data file-write*'));
    expect(allowHost).toBeGreaterThan(denyAll);
    expect(lines[allowHost]).toContain('(subpath "/var/folders/x/data/plugin-hosts/p")');
    const allowPkg = lines.findIndex((l) => l.startsWith('(allow file-read-data (subpath'));
    expect(lines[allowPkg]).toContain('(subpath "/var/folders/x/data/plugins/node_modules")');
    expect(lines[allowPkg]).toContain('(subpath "/var/folders/x/data/plugins/node_modules/pkg")');
    expect(lines.at(-2)).toContain(
      '(deny file-write* (subpath "/var/folders/x/data/plugins/node_modules/pkg")',
    );
    expect(lines.at(-1)).toBe('(deny network*)');
  });

  it('leaves the network open unless the grant declares none', () => {
    expect(seatbeltProfile({ ...spec, network: ['a.test'] })).not.toContain('deny network');
    expect(seatbeltProfile({ ...spec, network: [] })).not.toContain('deny network');
    expect(seatbeltProfile({ ...spec, network: undefined })).not.toContain('deny network');
  });

  it('profile escaping: a path with quotes or parens cannot end its literal and add rules', () => {
    const evil = '/tmp/x") (allow file-read-data (subpath "/Users/u/.ssh") ("';
    const profile = seatbeltProfile({ ...spec, pluginDir: evil });
    // Every line is still one rule made of well-formed string literals.
    const rule =
      /^\((?:version 1|allow default|(?:deny|allow) [a-z*-]+(?: [a-z*-]+)* (?:\(subpath "(?:[^"\\]|\\.)*"\) ?)+|deny network\*)\)$/;
    for (const line of profile.split('\n')) expect(line, line).toMatch(rule);
    expect(profile).toContain('\\") (allow file-read-data');
    expect(sbplString('a"b\\c')).toBe('"a\\"b\\\\c"');
    expect(() => sbplString('a\nb')).toThrow(/control characters/);
  });

  it('a package under node_modules also gets the hoisted node_modules dir (read-only)', () => {
    expect(readOnlyDirs('/d/plugins/node_modules/@s/pkg')).toEqual([
      '/d/plugins/node_modules',
      '/d/plugins/node_modules/@s/pkg',
    ]);
    expect(readOnlyDirs('/repo/plugins/echo')).toEqual(['/repo/plugins/echo']);
  });

  it('denies the shared sensitiveDenyPaths() manifest plus the plan home secrets, deduplicated', () => {
    const paths = deniedPaths({ ...spec, denyPaths: undefined, homeDir: '/Users/u' });
    expect(paths).toContain('/Users/u/.ssh');
    expect(paths).toContain('/Users/u/.config/gcloud');
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths.some((p) => p.endsWith('/secrets'))).toBe(true);
  });
});

describe('bwrap argv shape (Linux; written from the plan, not run here unless bwrap exists)', () => {
  const spec = {
    dataDir: '/home/u/.ethos',
    hostDir: '/home/u/.ethos/plugin-hosts/p',
    pluginDir: '/home/u/.ethos/plugins/node_modules/pkg',
    network: null,
    homeDir: '/home/u',
  } as const;

  it('binds root read-only, empties the state dir, then re-binds the host dir and package', () => {
    const args = bwrapArgs(spec, new Set(['/home/u/.ssh', '/home/u/.npmrc']));
    expect(args.slice(0, 3)).toEqual(['--ro-bind', '/', '/']);
    expect(args).toEqual(
      expect.arrayContaining([
        '--dev',
        '/dev',
        '--proc',
        '/proc',
        '--unshare-pid',
        '--die-with-parent',
      ]),
    );
    const tmpfs = args.indexOf('--tmpfs');
    expect(args.slice(tmpfs, tmpfs + 2)).toEqual(['--tmpfs', '/home/u/.ethos']);
    const bind = args.indexOf('--bind');
    expect(bind).toBeGreaterThan(tmpfs);
    expect(args.slice(bind, bind + 3)).toEqual(['--bind', spec.hostDir, spec.hostDir]);
    expect(args).toEqual(expect.arrayContaining(['--ro-bind', spec.pluginDir, spec.pluginDir]));
    expect(args).toContain('--unshare-net');
    // Only existing home secrets are masked: dirs with tmpfs, files with /dev/null.
    expect(args).toEqual(expect.arrayContaining(['--tmpfs', '/home/u/.ssh']));
    expect(args).not.toContain('/home/u/.aws');
    expect(args).toEqual(expect.arrayContaining(['--ro-bind', '/dev/null', '/home/u/.npmrc']));
  });

  it('shares the network unless the grant declares none', () => {
    expect(bwrapArgs({ ...spec, network: ['a.test'] }, new Set())).not.toContain('--unshare-net');
  });
});
