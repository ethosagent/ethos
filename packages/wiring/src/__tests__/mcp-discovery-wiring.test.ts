// `config.mcp.discoveryConcurrency` reaches the McpManager the composition root
// builds (plan hermes-0.22-hardening §5.2: compose-tools.ts passes it through).
// Driven through the real composition root, offline (same setup as
// chat-skill-propose.test.ts); the McpManager constructor options are captured
// through a spy subclass.

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createAgentLoop, type WiringConfig } from '../index';

const captured = vi.hoisted(() => [] as Array<Record<string, unknown> | undefined>);

vi.mock('@ethosagent/tools-mcp', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ethosagent/tools-mcp')>();
  class SpyMcpManager extends actual.McpManager {
    constructor(
      configs: ConstructorParameters<typeof actual.McpManager>[0],
      opts?: Record<string, unknown>,
    ) {
      super(configs, opts);
      captured.push(opts);
    }
  }
  return { ...actual, McpManager: SpyMcpManager };
});

let home: string;
let dataDir: string;
const prevEnv: Record<string, string | undefined> = {};

async function build(extra: Partial<WiringConfig>): Promise<void> {
  const runtime = await createAgentLoop(
    {
      provider: 'ollama',
      model: 'offline-test',
      baseUrl: 'http://127.0.0.1:9',
      apiKey: 'sk-dummy',
      personality: 'researcher',
      memory: 'markdown',
      ...extra,
    },
    { dataDir, workingDir: home, disableDocker: true, profile: 'cli' },
  );
  await runtime.dispose();
}

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'ethos-mcp-discovery-wiring-'));
  dataDir = join(home, '.ethos');
  mkdirSync(dataDir, { recursive: true });
  for (const key of ['HOME', 'ETHOS_STATE_DIR'] as const) prevEnv[key] = process.env[key];
  process.env.HOME = home;
  process.env.ETHOS_STATE_DIR = dataDir;
});

afterAll(() => {
  for (const [key, value] of Object.entries(prevEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true });
});

describe('MCP discovery concurrency wiring', () => {
  it('config.mcp.discoveryConcurrency reaches McpManager', async () => {
    captured.length = 0;
    await build({ mcp: { discoveryConcurrency: 3 } });
    expect(captured).toHaveLength(1);
    expect(captured[0]?.discoveryConcurrency).toBe(3);
  }, 120_000);

  it('leaves the manager on its default when the config sets nothing', async () => {
    captured.length = 0;
    await build({});
    expect(captured).toHaveLength(1);
    expect(captured[0]).not.toHaveProperty('discoveryConcurrency');
  }, 120_000);
});
