import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteApiKeyStore } from '@ethosagent/session-sqlite';
import qrTerminal from 'qrcode-terminal';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tempDir: string;

vi.mock('@ethosagent/config', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@ethosagent/config')>();
  return {
    ...orig,
    ethosDir: () => tempDir,
  };
});

// `printConnectQr` (the `--qr` path) reads config through `getStorage()` from
// `../wiring`, which is a process-wide `FsStorage` singleton independent of
// the `ethosDir` mock above — a real config file (and its secret references)
// would otherwise leak into this test. A storage stub that reports every path
// as absent keeps `readConfig` on its documented "no config" return (`null`)
// without touching the operator's real `~/.ethos/config.yaml`.
vi.mock('../wiring', () => ({
  getStorage: () => ({ read: async () => null }),
  getSecretsResolver: async () => ({}),
}));

// `printConnectQr` also dynamically imports `@ethosagent/web-api` for
// `resolveConnectInfo` — but that package's barrel (`apps/web-api/src/index.ts`,
// ~2300 lines) pulls in the whole extension graph (agent-mesh, dashboard,
// session-cards, skills, tools-mcp, wiring, …) just to reach one
// dependency-free pure function. Loading that graph fresh is slow enough
// (genuinely, not a hang: ~1.5s cold in isolation) to blow this test's
// timeout once the full suite's concurrent module loads contend for the
// same CPU. `resolveConnectInfo`'s own precedence rules are already pinned
// by `apps/web-api/src/__tests__/rpc/meta-connect-info.test.ts` — this test
// only needs *a* url to exercise the qrcode-terminal interop shape below, so
// stub it rather than pay for the barrel.
vi.mock('@ethosagent/web-api', () => ({
  resolveConnectInfo: (opts: { webHost: string; webPort: number }) => ({
    url: `http://${opts.webHost}:${opts.webPort}`,
    source: 'web.host',
    loopback: true,
  }),
}));

// `SqliteApiKeyStore.create` stores whatever scope strings it is handed. Before
// `--scopes` was validated, a typo minted a key that authenticated fine and
// authorized nothing — the failure only surfaced later as a 403 from `/v1/*`.

describe('ethos api-key create --scopes validation', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let writeSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'api-key-scopes-test-'));
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
  });

  afterEach(() => {
    logSpy.mockRestore();
    writeSpy.mockRestore();
    exitSpy.mockRestore();
  });

  function loggedText(): string {
    const calls = logSpy.mock.calls as unknown[][];
    return calls.map((call) => String(call[0] ?? '')).join('\n');
  }

  it('rejects an unknown scope and lists the valid ones', async () => {
    const { runApiKey } = await import('../commands/api-key');
    await expect(runApiKey(['create', '--name', 'typo', '--scopes', 'chats'])).rejects.toThrow(
      /process.exit\(1\)/,
    );

    const output = loggedText();
    expect(output).toMatch(/Unknown scope: chats/);
    expect(output).toMatch(/Valid scopes:/);
    expect(output).toMatch(/events:subscribe/);

    const store = new SqliteApiKeyStore(join(tempDir, 'sessions.db'));
    expect(await store.list()).toEqual([]);
    store.close();
  });

  it('names every unknown scope when several are wrong', async () => {
    const { runApiKey } = await import('../commands/api-key');
    await expect(
      runApiKey(['create', '--name', 'typos', '--scopes', 'chat,nope,alsonope']),
    ).rejects.toThrow(/process.exit\(1\)/);
    expect(loggedText()).toMatch(/Unknown scopes: nope, alsonope/);
  });

  it('accepts every member of the static enum', async () => {
    const { ApiKeyStaticScopeSchema } = await import('@ethosagent/web-contracts');
    const { runApiKey } = await import('../commands/api-key');
    await runApiKey([
      'create',
      '--name',
      'all-scopes',
      '--scopes',
      ApiKeyStaticScopeSchema.options.join(','),
      '--json',
    ]);

    const output = String(writeSpy.mock.calls[0]?.[0] ?? '');
    const parsed = JSON.parse(output) as { scopes: string[] };
    expect(parsed.scopes).toEqual([...ApiKeyStaticScopeSchema.options]);
  });

  // M-T4 (trust-before-reach, Part 3) — `mcp:<personality-id>` is the one
  // open-ended scope, so `--scopes` cannot validate it by list membership and
  // the "valid scopes" line cannot enumerate it.
  it('accepts an `mcp:<personality-id>` export scope', async () => {
    const { runApiKey } = await import('../commands/api-key');
    await runApiKey([
      'create',
      '--name',
      'reviewer-export',
      '--scopes',
      'mcp:reviewer,chat',
      '--json',
    ]);

    const output = String(writeSpy.mock.calls[0]?.[0] ?? '');
    const parsed = JSON.parse(output) as { scopes: string[] };
    expect(parsed.scopes).toEqual(['mcp:reviewer', 'chat']);
  });

  it('rejects a traversal-shaped export id and names the `mcp:` shape', async () => {
    const { runApiKey } = await import('../commands/api-key');
    await expect(
      runApiKey(['create', '--name', 'bad-export', '--scopes', 'mcp:../x']),
    ).rejects.toThrow(/process.exit\(1\)/);

    const output = loggedText();
    expect(output).toMatch(/Unknown scope: mcp:\.\.\/x/);
    // The hint has to name the open-ended form, or the enumerated list reads
    // as exhaustive when it is not.
    expect(output).toMatch(/mcp:<personality-id>/);

    const store = new SqliteApiKeyStore(join(tempDir, 'sessions.db'));
    expect(await store.list()).toEqual([]);
    store.close();
  });

  it('defaults to `chat`, the scope /v1/* requires', async () => {
    const { runApiKey } = await import('../commands/api-key');
    await runApiKey(['create', '--name', 'default-scopes', '--json']);

    const output = String(writeSpy.mock.calls[0]?.[0] ?? '');
    const parsed = JSON.parse(output) as { scopes: string[] };
    expect(parsed.scopes).toEqual(['chat']);
  });

  // mobile-app plan S13(d) — `--preset phone` writes exactly
  // `PHONE_PRESET_SCOPES`; the preset needs no `--name`.
  describe('--preset phone', () => {
    it('writes PHONE_PRESET_SCOPES and a hostname-derived name with no --name', async () => {
      const { PHONE_PRESET_SCOPES } = await import('@ethosagent/web-contracts');
      const { runApiKey } = await import('../commands/api-key');
      await runApiKey(['create', '--preset', 'phone', '--json']);

      const output = String(writeSpy.mock.calls[0]?.[0] ?? '');
      const parsed = JSON.parse(output) as { name: string; scopes: string[] };
      expect(parsed.scopes).toEqual(PHONE_PRESET_SCOPES);
      expect(parsed.name).toMatch(/^phone-/);
    });

    it('ignores --scopes when a preset is given', async () => {
      const { PHONE_PRESET_SCOPES } = await import('@ethosagent/web-contracts');
      const { runApiKey } = await import('../commands/api-key');
      await runApiKey(['create', '--preset', 'phone', '--scopes', 'chat', '--json']);

      const output = String(writeSpy.mock.calls[0]?.[0] ?? '');
      const parsed = JSON.parse(output) as { scopes: string[] };
      expect(parsed.scopes).toEqual(PHONE_PRESET_SCOPES);
    });

    it('honors an explicit --name over the hostname default', async () => {
      const { runApiKey } = await import('../commands/api-key');
      await runApiKey(['create', '--preset', 'phone', '--name', 'my-iphone', '--json']);

      const output = String(writeSpy.mock.calls[0]?.[0] ?? '');
      const parsed = JSON.parse(output) as { name: string };
      expect(parsed.name).toBe('my-iphone');
    });

    it('prints the trust sentence in human-readable output', async () => {
      const { runApiKey } = await import('../commands/api-key');
      await runApiKey(['create', '--preset', 'phone']);

      expect(loggedText()).toMatch(
        /This key lets the phone read, approve and talk\. It cannot change agents or settings\./,
      );
    });

    it('rejects an unknown preset', async () => {
      const { runApiKey } = await import('../commands/api-key');
      await expect(runApiKey(['create', '--preset', 'tablet', '--name', 'x'])).rejects.toThrow(
        /process.exit\(1\)/,
      );
      expect(loggedText()).toMatch(/Unknown preset "tablet"/);
    });

    // `--qr` shipped broken: `qrcode-terminal` is CJS, so its ESM namespace
    // carries `generate` only under `.default` — `ns.generate` (the original
    // bug) is `undefined` and calling it throws before anything renders.
    // Nothing exercised this path, so the bug shipped. Spying on the REAL
    // module's `default.generate` (rather than mocking the module away)
    // means a regression back to `ns.generate` fails this test the same way
    // it failed at the terminal: the spy is never called.
    describe('--qr', () => {
      let generateSpy: ReturnType<typeof vi.spyOn>;
      const savedEnv: Record<string, string | undefined> = {};

      beforeEach(() => {
        for (const key of ['ETHOS_PUBLIC_URL', 'ETHOS_WEB_HOST', 'ETHOS_WEB_PORT']) {
          savedEnv[key] = process.env[key];
          delete process.env[key];
        }
        generateSpy = vi.spyOn(qrTerminal, 'generate').mockImplementation(() => {});
      });

      afterEach(() => {
        generateSpy.mockRestore();
        for (const [key, value] of Object.entries(savedEnv)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      });

      it('builds the ethos://connect URL and renders it through the real qrcode-terminal shape', async () => {
        const { runApiKey } = await import('../commands/api-key');
        await runApiKey(['create', '--preset', 'phone', '--qr', '--json']);

        const output = String(writeSpy.mock.calls[0]?.[0] ?? '');
        const { key: secret } = JSON.parse(output) as { key: string };

        expect(generateSpy).toHaveBeenCalledTimes(1);
        const [connectUrl, opts] = generateSpy.mock.calls[0] as [string, { small: boolean }];
        expect(connectUrl).toMatch(
          new RegExp(`^ethos://connect\\?url=[^&]+&key=${encodeURIComponent(secret)}$`),
        );
        expect(opts).toEqual({ small: true });

        // Pin the interop shape itself, independent of the spy above: under
        // plain Node ESM this CJS package's namespace exposes `generate`
        // only through `.default` (verified against the installed
        // `qrcode-terminal` — `Object.keys` is `['default', 'error',
        // 'module.exports']`), which is exactly the shape the fixed source
        // reads (`(await import('qrcode-terminal')).default.generate`). Only
        // that positive assertion is pinned here — Vitest's own SSR
        // transform synthesizes extra top-level named exports for CJS
        // modules that plain Node does not, so asserting their absence would
        // pin a test-runner artifact instead of the real regression.
        const mod = await import('qrcode-terminal');
        expect(typeof mod.default.generate).toBe('function');
      });
    });
  });
});
