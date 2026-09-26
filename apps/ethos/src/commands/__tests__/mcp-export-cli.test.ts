// `ethos mcp serve --personality <id>` and `ethos mcp install <client>
// --personality <id>` (M-T7, plan/phases/trust-before-reach.md Part 3).
//
// The composition root is driven for real here — `runMcp(['serve', ...])` —
// with the loop, the observability handle and the export server stubbed, so the
// four decisions the CLI owns are tested where they are actually made rather
// than through a reimplementation of them:
//
//   fail-closed admission (M-D4) · pinned workdir (M-D11) ·
//   fail-closed approval (M-D10) · the summary line.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PersonalityConfig } from '@ethosagent/types';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// --- module mocks ----------------------------------------------------------

const created: Array<{ config: unknown; opts: Record<string, unknown> }> = [];
const exportServers: Array<{
  config: Record<string, unknown>;
  started: string[];
}> = [];
const recorded: Array<Record<string, unknown>> = [];

let runtime: ReturnType<typeof makeRuntime>;

vi.mock('../../wiring', () => ({
  createAgentLoop: vi.fn(async (config: unknown, opts: Record<string, unknown> = {}) => {
    created.push({ config, opts });
    return runtime;
  }),
  createLLM: vi.fn(async () => {
    throw new Error('the smart reviewer must not be constructed in these tests');
  }),
  getEthosObservability: () => ({
    recordEthosEvent: (e: Record<string, unknown>) => recorded.push(e),
  }),
  getSecretsResolver: async () => ({ get: async () => undefined }),
  getStorage: () => ({}),
  closeObservabilityStore: () => {},
}));

vi.mock('@ethosagent/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ethosagent/config')>();
  return {
    ...actual,
    readConfig: vi.fn(async () => ({ model: 'test-model', provider: 'anthropic' })),
  };
});

vi.mock('@ethosagent/mcp-server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ethosagent/mcp-server')>();
  class FakeExportServer {
    readonly started: string[] = [];
    constructor(readonly config: Record<string, unknown>) {
      exportServers.push({ config, started: this.started });
    }
    async start(): Promise<void> {
      this.started.push('stdio');
    }
    async serveHttp(): Promise<unknown> {
      this.started.push('http');
      return { close: async () => {} };
    }
    async close(): Promise<void> {}
  }
  return { ...actual, PersonalityExportServer: FakeExportServer };
});

// --- fixtures --------------------------------------------------------------

const REACH = ['read_file', 'web_search', 'terminal', 'memory_read', 'memory_write'];

function makeRuntime(personality: PersonalityConfig | undefined) {
  const modifying: Array<(payload: unknown) => Promise<unknown>> = [];
  return {
    modifying,
    loop: {
      hooks: {
        registerVoid: vi.fn(() => () => {}),
        registerModifying: vi.fn((_event: string, handler: (p: unknown) => Promise<unknown>) => {
          modifying.push(handler);
          return () => {};
        }),
      },
    },
    personalities: {
      get: (id: string) => (personality && personality.id === id ? personality : undefined),
    },
    refreshPersonalities: vi.fn(async () => {}),
    toolRegistry: {
      getAvailable: () => REACH.map((name) => ({ name })),
      toolNamesForPersonality: () => new Set(REACH),
    },
    dispose: vi.fn(async () => {}),
    drain: vi.fn(async () => {}),
  };
}

class ExitError extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code})`);
  }
}

let stateDir: string;
let stderr: string[];
let previousStateDir: string | undefined;

// `runServeExport` installs SIGINT/SIGTERM shutdown handlers, one pair per run;
// fifteen runs in one process trip Node's max-listeners warning. Snapshot and
// restore them so the suite leaves the process exactly as it found it.
type Signal = 'SIGINT' | 'SIGTERM';
let signalListeners: Record<Signal, NodeJS.SignalsListener[]>;

// `import('../mcp')` loads the whole CLI composition graph: ~3s cold, far more
// on a loaded host. Paid inside the first test, it could outrun that test's
// timeout — and vitest does not cancel a timed-out test, so its run finished
// later and wrote its `unknown_personality` line into the NEXT test's freshly
// reset `stderr` ("expected 'unknown_personality' to be 'export_disabled'";
// reproduced with --testTimeout=1500). Pay it once here, under its own budget.
beforeAll(async () => {
  await import('../mcp');
}, 120_000);

beforeEach(() => {
  signalListeners = {
    SIGINT: process.listeners('SIGINT') as NodeJS.SignalsListener[],
    SIGTERM: process.listeners('SIGTERM') as NodeJS.SignalsListener[],
  };
  created.length = 0;
  exportServers.length = 0;
  recorded.length = 0;
  stderr = [];
  previousStateDir = process.env.ETHOS_STATE_DIR;
  stateDir = mkdtempSync(join(tmpdir(), 'ethos-mcp-export-'));
  process.env.ETHOS_STATE_DIR = stateDir;
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    stderr.push(String(chunk));
    return true;
  });
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ExitError(code ?? 0);
  }) as never);
});

afterEach(() => {
  for (const signal of ['SIGINT', 'SIGTERM'] as Signal[]) {
    process.removeAllListeners(signal);
    for (const listener of signalListeners[signal]) process.on(signal, listener);
  }
  vi.restoreAllMocks();
  if (previousStateDir === undefined) delete process.env.ETHOS_STATE_DIR;
  else process.env.ETHOS_STATE_DIR = previousStateDir;
  rmSync(stateDir, { recursive: true, force: true });
});

async function serve(personality: PersonalityConfig | undefined, argv: string[]): Promise<number> {
  runtime = makeRuntime(personality);
  const { runMcp } = await import('../mcp');
  try {
    await runMcp(['serve', ...argv]);
  } catch (err) {
    if (err instanceof ExitError) return err.code;
    throw err;
  }
  return 0;
}

const exported = (over: Partial<PersonalityConfig> = {}): PersonalityConfig =>
  ({
    id: 'reviewer',
    name: 'Reviewer',
    mcp_export: { enabled: true, expose_tools: ['read_file', 'web_search'] },
    ...over,
  }) as PersonalityConfig;

// --- M-D4: fail-closed admission -------------------------------------------

describe('ethos mcp serve --personality — admission is fail-closed (M-D4)', () => {
  it('exits 1 with a JSON error on stderr for an unknown personality', async () => {
    const code = await serve(undefined, ['--personality', 'nope']);
    expect(code).toBe(1);
    const line = JSON.parse(stderr[0] ?? '{}');
    expect(line.code).toBe('unknown_personality');
    expect(line.level).toBe('error');
    expect(exportServers).toHaveLength(0);
  });

  it('exits 1 when mcp_export is absent entirely', async () => {
    const code = await serve({ id: 'reviewer', name: 'Reviewer' } as PersonalityConfig, [
      '--personality',
      'reviewer',
    ]);
    expect(code).toBe(1);
    expect(JSON.parse(stderr[0] ?? '{}').code).toBe('export_disabled');
    expect(exportServers).toHaveLength(0);
  });

  it('exits 1 when mcp_export.enabled is false', async () => {
    const code = await serve(exported({ mcp_export: { enabled: false } }), [
      '--personality',
      'reviewer',
    ]);
    expect(code).toBe(1);
    expect(JSON.parse(stderr[0] ?? '{}').code).toBe('export_disabled');
  });

  it('refuses --http for a localhost export with a readable error, not a stack trace', async () => {
    const code = await serve(exported(), ['--personality', 'reviewer', '--http']);
    expect(code).toBe(1);
    const line = JSON.parse(stderr[0] ?? '{}');
    expect(line.code).toBe('http_requires_bearer');
    expect(line.msg).toContain('auth: bearer');
    expect(exportServers).toHaveLength(0);
  });
});

// --- M-D11 / M-D6: how the loop is built -----------------------------------

describe('ethos mcp serve --personality — the loop it builds', () => {
  it('pins the working directory under ~/.ethos, never the process cwd (M-D11)', async () => {
    await serve(exported(), ['--personality', 'reviewer']);
    const opts = created[0]?.opts ?? {};
    expect(opts.workingDir).toBe(join(stateDir, 'personalities', 'reviewer'));
    expect(opts.workingDir).not.toBe(process.cwd());
  });

  it('runs the mcp profile with post-turn learning off (M-D6/M-D13)', async () => {
    await serve(exported(), ['--personality', 'reviewer']);
    const opts = created[0]?.opts ?? {};
    expect(opts.profile).toBe('mcp');
    expect(opts.disablePostTurnLearning).toBe(true);
  });

  it('registers a before_tool_call hook, which is also the gated-posture claim (M-D10)', async () => {
    await serve(exported(), ['--personality', 'reviewer']);
    expect(runtime.loop.hooks.registerModifying).toHaveBeenCalledWith(
      'before_tool_call',
      expect.any(Function),
    );
  });

  it('injects resolveScope and the live registry into the server (M-D13)', async () => {
    await serve(exported(), ['--personality', 'reviewer']);
    const config = exportServers[0]?.config ?? {};
    expect(config.personalityId).toBe('reviewer');
    expect(config.personalities).toBe(runtime.personalities);
    expect(config.refreshPersonalities).toBe(runtime.refreshPersonalities);
    expect(config.toolRegistry).toBe(runtime.toolRegistry);
    expect(typeof config.resolveScope).toBe('function');
  });

  it('passes ETHOS_MCP_KEY through as the stdio secret', async () => {
    process.env.ETHOS_MCP_KEY = '  sk-ethos-abcd1234  ';
    try {
      await serve(exported({ mcp_export: { enabled: true, auth: 'bearer' } }), [
        '--personality',
        'reviewer',
      ]);
    } finally {
      delete process.env.ETHOS_MCP_KEY;
    }
    expect(exportServers[0]?.config.stdioSecret).toBe('sk-ethos-abcd1234');
    expect(exportServers[0]?.config.authenticator).toBeDefined();
  });

  it('opens no authenticator for a localhost export', async () => {
    await serve(exported(), ['--personality', 'reviewer']);
    expect(exportServers[0]?.config.authenticator).toBeUndefined();
  });
});

// --- the summary line ------------------------------------------------------

describe('ethos mcp serve --personality — the summary line', () => {
  const summary = (): string =>
    stderr.map((s) => s.trim()).filter((s) => s.startsWith('exporting'))[0] ?? '';

  it('renders exactly the documented shape', async () => {
    await serve(exported(), ['--personality', 'reviewer']);
    expect(summary()).toBe(
      'exporting reviewer — tools: read_file, web_search · memory: none · conversations: off · auth: localhost (stdio)',
    );
  });

  it('names a dropped tool rather than silently ignoring it', async () => {
    await serve(
      exported({
        mcp_export: { enabled: true, expose_tools: ['read_file', 'kanban_complete'] },
      }),
      ['--personality', 'reviewer'],
    );
    expect(summary()).toBe(
      'exporting reviewer — tools: read_file · dropped: kanban_complete · memory: none · conversations: off · auth: localhost (stdio)',
    );
  });

  it('renders the bearer / sessions-on / memory-full variant', async () => {
    await serve(
      exported({
        mcp_export: {
          enabled: true,
          expose_tools: 'all',
          expose_memory: 'full',
          expose_sessions: true,
          auth: 'bearer',
        },
      }),
      ['--personality', 'reviewer'],
    );
    expect(summary()).toBe(
      'exporting reviewer — tools: memory_read, memory_write, read_file, terminal, web_search · memory: full · conversations: on · auth: bearer (stdio + HTTP)',
    );
  });

  it('says "none" rather than an empty list for a conversation-only specialist', async () => {
    await serve(exported({ mcp_export: { enabled: true } }), ['--personality', 'reviewer']);
    expect(summary()).toContain('tools: none');
  });
});

// --- `ethos mcp install <client> --personality <id>` ------------------------

describe('ethos mcp install --personality', () => {
  async function install(
    personality: PersonalityConfig,
    argv: string[],
  ): Promise<{ config: Record<string, unknown>; stdout: string[] }> {
    runtime = makeRuntime(personality);
    const configPath = join(stateDir, 'claude_desktop_config.json');
    const { claudeDesktop } = await import('@ethosagent/mcp-server');
    vi.spyOn(claudeDesktop, 'configPath').mockReturnValue(configPath);
    // A console entry the user installed on purpose, already in the file.
    writeFileSync(
      configPath,
      JSON.stringify({
        mcpServers: { ethos: { command: 'node', args: ['ethos', 'mcp', 'serve'] } },
      }),
      'utf8',
    );
    const stdout: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...parts: unknown[]) => {
      stdout.push(parts.map(String).join(' '));
    });

    const { runMcp } = await import('../mcp');
    await runMcp(['install', 'claude-desktop', ...argv]);
    return { config: JSON.parse(readFileSync(configPath, 'utf8')), stdout };
  }

  it('writes ethos-<id> beside the existing ethos entry without clobbering it', async () => {
    const { config } = await install(exported(), ['--personality', 'reviewer']);
    const servers = config.mcpServers as Record<string, { args: string[] }>;
    expect(Object.keys(servers).sort()).toEqual(['ethos', 'ethos-reviewer']);
    expect(servers.ethos?.args).toEqual(['ethos', 'mcp', 'serve']);
    expect(servers['ethos-reviewer']?.args).toEqual(
      expect.arrayContaining(['mcp', 'serve', '--personality', 'reviewer']),
    );
  });

  it('mints a mcp:<id> key into env under bearer and prints only the prefix', async () => {
    const { config, stdout } = await install(
      exported({ mcp_export: { enabled: true, expose_tools: ['read_file'], auth: 'bearer' } }),
      ['--personality', 'reviewer'],
    );
    const entry = (config.mcpServers as Record<string, { env?: Record<string, string> }>)[
      'ethos-reviewer'
    ];
    const secret = entry?.env?.ETHOS_MCP_KEY ?? '';
    expect(secret.startsWith('sk-ethos-')).toBe(true);

    const printed = stdout.join('\n');
    // The prefix is shown so the operator can revoke it; the secret never is.
    expect(printed).toContain(secret.slice(0, 'sk-ethos-'.length + 8));
    expect(printed).not.toContain(secret);
    expect(printed).toContain('ethos api-key revoke');
  });

  it('writes no env block for a localhost export', async () => {
    const { config } = await install(exported(), ['--personality', 'reviewer']);
    const entry = (config.mcpServers as Record<string, Record<string, unknown>>)['ethos-reviewer'];
    expect(entry?.env).toBeUndefined();
  });

  it('refuses to install a personality that declares no export', async () => {
    const { config } = await install(exported({ mcp_export: { enabled: false } }), [
      '--personality',
      'reviewer',
    ]);
    expect(Object.keys(config.mcpServers as Record<string, unknown>)).toEqual(['ethos']);
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });
});
