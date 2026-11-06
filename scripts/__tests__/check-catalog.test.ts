import type { CatalogEntry } from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import {
  checkEntry,
  ENTRIES_PATH,
  type GitTreeResult,
  main,
  type PackedPackage,
  type Runner,
  resolveBase,
  runChecks,
  scanPermissions,
  selectChanged,
} from '../check-catalog';

const NOW = new Date('2026-11-05T00:00:00Z');
const SRI = `sha512-${'A'.repeat(86)}==`;
const OTHER_SRI = `sha512-${'B'.repeat(86)}==`;
const SHA = 'a'.repeat(64);

const base = {
  description: 'd',
  category: 'Utilities',
  publisher: 'Acme',
  tier: 'verified',
  reviewedAt: '2026-11-05',
} as const;

function npmEntry(over: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    ...base,
    id: 'thing',
    kind: 'mcp',
    name: 'Thing',
    pin: { type: 'npm', package: '@acme/thing', version: '1.2.3', integrity: SRI },
    capabilities: { network: [], auth: 'none', env: [], filesystem: 'none', shell: false },
    license: 'MIT',
    mcp: { argsAfterSpec: [], argVars: [], envVars: [] },
    ...over,
  };
}

function remoteEntry(over: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    ...base,
    id: 'svc',
    kind: 'mcp',
    name: 'Svc',
    pin: { type: 'remote', url: 'https://mcp.svc.test/mcp', transport: 'streamable-http' },
    capabilities: {
      network: ['mcp.svc.test'],
      auth: 'oauth',
      env: [],
      filesystem: 'none',
      shell: false,
    },
    license: null,
    ...over,
  };
}

const CLEAN_PACK: PackedPackage = {
  integrity: SRI,
  pkgJson: { name: '@acme/thing' },
  sources: [{ path: 'dist/index.js', content: 'export const x = 1;\n' }],
};

const CLEAN_TREE: GitTreeResult = {
  outcome: 'ok',
  detail: 'fetched; digest matches',
  skillMd: {
    path: 'SKILL.md',
    content: '---\nname: pdf\ndescription: PDFs\n---\n\n# PDF\n\nExtract text.\n',
  },
  sources: [],
  license: 'Permission is hereby granted, free of charge, to any person obtaining a copy',
};

/** `npm view <spec> dist.integrity license --json` prints one object for two fields. */
const npmView =
  (over: { integrity?: string; license?: string } = {}) =>
  async (args: string[]) => {
    expect(args).toEqual(['view', '@acme/thing@1.2.3', 'dist.integrity', 'license', '--json']);
    return JSON.stringify({
      'dist.integrity': over.integrity ?? SRI,
      license: over.license ?? 'MIT',
    });
  };

/** A runner whose every call succeeds with the clean answer; tests override one seam. */
function runner(over: Partial<Runner> = {}): Runner {
  return {
    npm: vi.fn(npmView()),
    git: vi.fn(async () => ''),
    gitTree: vi.fn(async () => CLEAN_TREE),
    fetch: vi.fn(async () => new Response('{}', { status: 200 })),
    osv: vi.fn(async () => ({ safe: true, advisories: [] })),
    packNpm: vi.fn(async () => CLEAN_PACK),
    now: () => NOW,
    ...over,
  };
}

const status = async (e: CatalogEntry, r: Runner, check: string) =>
  (await checkEntry(e, r)).results.find((c) => c.check === check)?.status;

describe('check-catalog: npm', () => {
  it('passes a clean entry', async () => {
    const rep = await checkEntry(npmEntry(), runner());
    expect(rep.results.filter((c) => c.status === 'fail')).toEqual([]);
  });

  it('an integrity mismatch fails', async () => {
    const r = runner({
      npm: vi.fn(npmView({ integrity: OTHER_SRI })),
    });
    expect(await status(npmEntry(), r, 'pin')).toBe('fail');
  });

  it('a version that is not published fails', async () => {
    const r = runner({ npm: vi.fn(async () => '') });
    expect(await status(npmEntry(), r, 'pin')).toBe('fail');
  });

  it('a red scanner finding fails; a clean tree passes', async () => {
    const evil: PackedPackage = {
      integrity: SRI,
      pkgJson: {},
      sources: [{ path: 'dist/index.js', content: 'eval(process.env.PAYLOAD);\n' }],
    };
    expect(await status(npmEntry(), runner({ packNpm: async () => evil }), 'code-scan')).toBe(
      'fail',
    );
    expect(await status(npmEntry(), runner(), 'code-scan')).toBe('pass');
  });
});

describe('check-catalog: OSV', () => {
  // The stub answers per version, as the real OSV query does.
  const osvByVersion: Runner['osv'] = async (_name, o) =>
    o?.version === '1.2.3'
      ? { safe: false, advisories: [{ id: 'GHSA-bad', summary: 's', severity: 'HIGH' }] }
      : { safe: true, advisories: [{ id: 'GHSA-bad', summary: 's', severity: 'HIGH' }] };

  it('HIGH on the pinned version fails, the same advisory on another version passes', async () => {
    const r = runner({ osv: vi.fn(osvByVersion) });
    expect(await status(npmEntry(), r, 'osv')).toBe('fail');
    const other = npmEntry({
      pin: { type: 'npm', package: '@acme/thing', version: '1.2.4', integrity: SRI },
    });
    expect(await status(other, r, 'osv')).toBe('pass');
  });

  it('is asked with version, ecosystem and failClosed', async () => {
    const osv = vi.fn(async () => ({ safe: true, advisories: [] }));
    await checkEntry(npmEntry(), runner({ osv }));
    expect(osv).toHaveBeenCalledWith('@acme/thing', {
      version: '1.2.3',
      ecosystem: 'npm',
      failClosed: true,
    });
  });

  it('an unreachable OSV fails closed in the script', async () => {
    const osv = vi.fn(async () => ({ safe: false, advisories: [], error: 'network timeout' }));
    expect(await status(npmEntry(), runner({ osv }), 'osv')).toBe('fail');
  });
});

describe('check-catalog: plugin declared vs actual', () => {
  const plugin = (network: string[], shell = false): CatalogEntry =>
    npmEntry({
      kind: 'plugin',
      mcp: undefined,
      plugin: { pluginId: 'thing' },
      capabilities: { network, auth: 'none', env: [], filesystem: 'none', shell },
    });
  const packWith = (permissions: unknown): PackedPackage => ({
    integrity: SRI,
    pkgJson: { name: '@acme/thing', ethos: { permissions } },
    sources: [{ path: 'index.js', content: 'export {};\n' }],
  });

  it('a declared network that misses a permissions host fails', async () => {
    const r = runner({
      packNpm: async () => packWith({ network: ['api.a.test', 'api.b.test'] }),
    });
    expect(await status(plugin(['api.a.test']), r, 'declared-vs-actual')).toBe('fail');
  });

  it('a permissions subset with equal shell passes', async () => {
    const r = runner({ packNpm: async () => packWith({ network: ['api.a.test'], shell: true }) });
    expect(await status(plugin(['api.a.test', 'api.b.test'], true), r, 'declared-vs-actual')).toBe(
      'pass',
    );
  });

  it('a shell mismatch fails', async () => {
    const r = runner({ packNpm: async () => packWith({ network: ['api.a.test'] }) });
    expect(await status(plugin(['api.a.test'], true), r, 'declared-vs-actual')).toBe('fail');
  });
});

describe('check-catalog: remote', () => {
  const rpc = (result: unknown) => JSON.stringify({ jsonrpc: '2.0', id: 1, result });

  it('401 with WWW-Authenticate passes for an oauth entry', async () => {
    const r = runner({
      fetch: async () =>
        new Response('', { status: 401, headers: { 'www-authenticate': 'Bearer realm="x"' } }),
    });
    expect(await status(remoteEntry(), r, 'pin')).toBe('pass');
  });

  it('401 on a no-auth entry, 200 on an oauth entry, and 404 all fail', async () => {
    const challenge = async () =>
      new Response('', { status: 401, headers: { 'www-authenticate': 'Bearer' } });
    expect(
      await status(
        remoteEntry({ capabilities: { ...remoteEntry().capabilities, auth: 'none' } }),
        runner({ fetch: challenge }),
        'pin',
      ),
    ).toBe('fail');
    expect(
      await status(remoteEntry(), runner({ fetch: async () => new Response(rpc({})) }), 'pin'),
    ).toBe('fail');
    expect(
      await status(
        remoteEntry(),
        runner({ fetch: async () => new Response('', { status: 404 }) }),
        'pin',
      ),
    ).toBe('fail');
  });

  it('a url host missing from capabilities.network fails', async () => {
    const e = remoteEntry({
      capabilities: { ...remoteEntry().capabilities, network: ['other.test'] },
    });
    expect(await status(e, runner(), 'declared-vs-actual')).toBe('fail');
    expect(await status(remoteEntry(), runner(), 'declared-vs-actual')).toBe('pass');
  });

  it('no-auth remote: tools/list count must equal toolCount', async () => {
    const e = remoteEntry({
      capabilities: { ...remoteEntry().capabilities, auth: 'none', toolCount: 2 },
    });
    const withTools = (n: number): Runner['fetch'] => {
      let call = 0;
      return async () => {
        call++;
        if (call === 1)
          return new Response(rpc({ protocolVersion: 'x' }), {
            headers: { 'mcp-session-id': 's1', 'content-type': 'application/json' },
          });
        if (call === 2) return new Response('', { status: 202 });
        return new Response(
          `event: message\ndata: ${rpc({ tools: Array.from({ length: n }, () => ({})) })}\n\n`,
          { headers: { 'content-type': 'text/event-stream' } },
        );
      };
    };
    expect(await status(e, runner({ fetch: withTools(2) }), 'tool-count')).toBe('pass');
    expect(await status(e, runner({ fetch: withTools(3) }), 'tool-count')).toBe('fail');
  });
});

describe('check-catalog: licence', () => {
  it('npm licence must equal the entry, except the explicit allowance', async () => {
    const npmLicense = (v: string) =>
      runner({
        npm: vi.fn(npmView({ license: v })),
      });
    expect(await status(npmEntry(), npmLicense('Apache-2.0'), 'licence')).toBe('fail');
    // "SEE LICENSE IN LICENSE" passes only for an id in LICENSE_FIELD_ALLOWANCES...
    expect(await status(npmEntry(), npmLicense('SEE LICENSE IN LICENSE'), 'licence')).toBe('fail');
    const fs = npmEntry({ id: 'filesystem', license: 'MIT AND Apache-2.0' });
    expect(await status(fs, npmLicense('SEE LICENSE IN LICENSE'), 'licence')).toBe('pass');
    // ...and only while the registry still says exactly that.
    expect(await status(fs, npmLicense('GPL-3.0'), 'licence')).toBe('fail');
  });

  it('PyPI licence: expression, license or classifier must name the entry licence', async () => {
    const e: CatalogEntry = {
      ...npmEntry(),
      pin: { type: 'pypi', package: 'mcp-server-x', version: '1.0.0', integrity: `sha256-${SHA}` },
    };
    const pypi = (info: object) =>
      runner({
        fetch: async () =>
          new Response(JSON.stringify({ info, urls: [{ digests: { sha256: SHA } }] })),
      });
    expect(
      await status(e, pypi({ classifiers: ['License :: OSI Approved :: MIT License'] }), 'licence'),
    ).toBe('pass');
    expect(await status(e, pypi({ license: 'GPL-3.0' }), 'licence')).toBe('fail');
  });

  it('PyPI pin: a sha256 with no matching file fails; python has no code scan', async () => {
    const e: CatalogEntry = {
      ...npmEntry(),
      pin: { type: 'pypi', package: 'mcp-server-x', version: '1.0.0', integrity: `sha256-${SHA}` },
    };
    const r = runner({
      fetch: async () =>
        new Response(
          JSON.stringify({
            info: { license: 'MIT' },
            urls: [{ digests: { sha256: 'b'.repeat(64) } }],
          }),
        ),
    });
    expect(await status(e, r, 'pin')).toBe('fail');
    expect(await status(e, r, 'code-scan')).toBe('skip');
  });
});

describe('check-catalog: git and staleness', () => {
  it('a git entry is fetched with withGitPinnedTree and checked for digest, scan and licence', async () => {
    const e: CatalogEntry = {
      ...base,
      id: 'sk',
      kind: 'skill',
      name: 'Sk',
      pin: {
        type: 'git',
        repo: 'https://github.com/a/b',
        commit: 'c'.repeat(40),
        contentDigest: `sha256-${SHA}`,
      },
      capabilities: { network: [], auth: 'none', env: [], filesystem: 'none', shell: false },
      license: 'MIT',
      skill: { skillName: 'sk' },
    };
    const status = async (r: Runner, check: string) =>
      (await checkEntry(e, r)).results.find((c) => c.check === check)?.status;
    const tree = (over: Partial<GitTreeResult>) =>
      runner({ gitTree: vi.fn(async () => ({ ...CLEAN_TREE, ...over })) });

    // A matching digest and a clean SKILL.md pass with no failure at all.
    const clean = await checkEntry(e, runner());
    expect(clean.results.some((c) => c.status === 'fail')).toBe(false);
    expect(clean.results.find((c) => c.check === 'pin')?.status).toBe('pass');
    expect(clean.results.find((c) => c.check === 'code-scan')?.status).toBe('pass');
    expect(clean.results.find((c) => c.check === 'licence')?.status).toBe('pass');

    // A digest mismatch fails and names both digests.
    const mismatch = await checkEntry(
      e,
      tree({ outcome: 'mismatch', detail: 'x', actualDigest: 'sha256-OTHER' }),
    );
    const pin = mismatch.results.find((c) => c.check === 'pin');
    expect(pin?.status).toBe('fail');
    expect(pin?.detail).toContain('sha256-OTHER');
    expect(await status(tree({ outcome: 'fetch-failed', detail: 'no such commit' }), 'pin')).toBe(
      'fail',
    );
    expect(await status(tree({ outcome: 'refused', detail: 'symlink' }), 'pin')).toBe('fail');

    // D16: a yellow finding in SKILL.md fails, not only red.
    const yellow = {
      path: 'SKILL.md',
      content: '---\nname: sk\ndescription: d\n---\n\nSee https://example.com/x for the steps.\n',
    };
    expect(await status(tree({ skillMd: yellow }), 'code-scan')).toBe('fail');
    expect(await status(tree({ skillMd: null }), 'code-scan')).toBe('fail');
    // A red finding in a bundled source file fails.
    expect(
      await status(tree({ sources: [{ path: 'x.js', content: "eval('1');\n" }] }), 'code-scan'),
    ).toBe('fail');

    // Licence: a different text fails; no LICENSE file only warns.
    expect(await status(tree({ license: 'All rights reserved' }), 'licence')).toBe('fail');
    expect(await status(tree({ license: null }), 'licence')).toBe('warn');

    // The checks that cannot run for a git pin say so rather than pass.
    expect(clean.results.find((c) => c.check === 'osv')?.status).toBe('skip');
  });

  it('reviewedAt older than 365 days warns and does not fail', async () => {
    const stale = npmEntry({ reviewedAt: '2025-01-01' });
    const rep = await checkEntry(stale, runner());
    expect(rep.results.find((c) => c.check === 'staleness')?.status).toBe('warn');
    expect(rep.results.some((c) => c.status === 'fail')).toBe(false);
  });
});

describe('check-catalog: --changed', () => {
  const entries = [npmEntry({ id: 'a' }), npmEntry({ id: 'b' }), remoteEntry({ id: 'c' })];

  it('selects only touched entries, by kind/id file path', async () => {
    const git = vi.fn(async (args: string[]) =>
      args[0] === 'diff'
        ? `${ENTRIES_PATH}/mcp/b.ts\n${ENTRIES_PATH}/index.ts\n${ENTRIES_PATH}/mcp/gone.ts\n`
        : 'sha\n',
    );
    const picked = await selectChanged(runner({ git }), entries);
    expect(picked.map((e) => e.id)).toEqual(['b']);
    expect(git).toHaveBeenCalledWith(['diff', '--name-only', 'origin/main', '--', ENTRIES_PATH]);
  });

  it('falls back to main when origin/main is absent', async () => {
    const git = vi.fn(async (args: string[]) => {
      if (args[0] === 'rev-parse') throw new Error('unknown revision');
      return '';
    });
    const r = runner({ git });
    expect(await resolveBase(r)).toBe('main');
    expect(await selectChanged(r, entries)).toEqual([]);
    expect(git).toHaveBeenCalledWith(['diff', '--name-only', 'main', '--', ENTRIES_PATH]);
  });
});

describe('check-catalog: scanPermissions', () => {
  const withNetwork = (network: string[]) =>
    npmEntry({ capabilities: { ...npmEntry().capabilities, network } });
  const telemetry: PackedPackage = {
    integrity: SRI,
    pkgJson: {},
    sources: [{ path: 'dist/index.js', content: "await fetch('https://telemetry.example/x');\n" }],
  };
  const codeScan = async (e: CatalogEntry) =>
    (await checkEntry(e, runner({ packNpm: async () => telemetry }))).results.find(
      (c) => c.check === 'code-scan',
    );

  it("maps ['*'] to unrestricted, [] to undeclared, hosts to the host list", () => {
    expect(scanPermissions(withNetwork(['*']), {}).network).toEqual([]);
    expect(scanPermissions(withNetwork([]), {}).network).toBeUndefined();
    expect(scanPermissions(withNetwork(['a.test']), {}).network).toEqual(['a.test']);
  });

  it('an entry with network [] has its network calls flagged; ["*"] suppresses them', async () => {
    expect((await codeScan(withNetwork([])))?.detail).toContain('(1 yellow)');
    expect((await codeScan(withNetwork(['*'])))?.detail).toContain('(0 yellow)');
  });
});

describe('check-catalog: tarball bound to the pin', () => {
  it('a packed tarball whose digest differs from the pin fails and is not scanned', async () => {
    const r = runner({
      packNpm: async () => ({ integrity: OTHER_SRI, pkgJson: null, sources: [] }),
    });
    const rep = await checkEntry(npmEntry(), r);
    const scan = rep.results.find((c) => c.check === 'code-scan');
    expect(scan?.status).toBe('fail');
    expect(scan?.detail).toContain('not scanned');
  });

  it('asks the runner to verify against the entry integrity', async () => {
    const packNpm = vi.fn(async () => CLEAN_PACK);
    await checkEntry(npmEntry(), runner({ packNpm }));
    expect(packNpm).toHaveBeenCalledWith('@acme/thing', '1.2.3', SRI);
  });
});

describe('check-catalog: remote licence (D6)', () => {
  it('a remote entry with a non-null licence fails', async () => {
    const e = remoteEntry({ license: 'MIT' });
    const r = runner({
      fetch: async () =>
        new Response('', { status: 401, headers: { 'www-authenticate': 'Bearer' } }),
    });
    expect(await status(e, r, 'licence')).toBe('fail');
  });
});

describe('check-catalog: runChecks and main', () => {
  const quiet = () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  };

  it('reports in id order whatever finishes first', async () => {
    const ids = ['d', 'b', 'e', 'a', 'c', 'f'];
    const entries = ids.map((id) => npmEntry({ id }));
    const reports = await runChecks(entries, runner());
    expect(reports.map((r) => r.id)).toEqual([...ids].sort());
  });

  it('never runs more than 4 entries at once', async () => {
    let live = 0;
    let peak = 0;
    const r = runner({
      osv: async () => {
        live++;
        peak = Math.max(peak, live);
        await new Promise((res) => setTimeout(res, 5));
        live--;
        return { safe: true, advisories: [] };
      },
    });
    await runChecks(
      Array.from({ length: 10 }, (_, i) => npmEntry({ id: `e${i}` })),
      r,
    );
    expect(peak).toBeLessThanOrEqual(4);
  });

  it('exit codes: 0 clean, 1 on a failed check, 2 on usage', async () => {
    quiet();
    const entries = [npmEntry()];
    expect(await main(['--all'], runner(), entries)).toBe(0);
    const failing = runner({ npm: vi.fn(npmView({ integrity: OTHER_SRI })) });
    expect(await main(['--all'], failing, entries)).toBe(1);
    expect(await main([], runner(), entries)).toBe(2);
    expect(await main(['--all', '--changed'], runner(), entries)).toBe(2);
    vi.restoreAllMocks();
  });

  it('--changed with nothing touched exits 0 without running any check', async () => {
    quiet();
    const r = runner();
    expect(await main(['--changed'], r, [npmEntry()])).toBe(0);
    expect(r.npm).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});
