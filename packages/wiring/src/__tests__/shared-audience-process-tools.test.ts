// Drift gate for `SHARED_AUDIENCE_EXCLUDED_TOOLS`
// (packages/core/src/agent-loop/audience.ts), plan
// personality-memory-boundary G1 / D6(a) / D21, verification round B1/B12.
//
// A shared turn's private-memory boundary is enforced on Storage and on the
// file-reach capability. A tool that spawns a host process bypasses both — a
// shell can `cat MEMORY.md` — and a tool that relays the room's prompt to a
// mesh peer has it run where the peer's own memory is loaded. Neither kind may
// be reachable from a shared turn unless it is shown to be safe.
//
// This gate composes the REAL tool registry (`createAgentLoop` under the `cli`
// and `web` profiles, plus the browser and A2A factories a host registers
// outside it) and checks, in both directions:
//
//   1. every tool declaring `capabilities.process` is in the exclusion list or
//      in PROCESS_TOOLS_ALLOWED below with the reason it cannot read host
//      files (catches a NEW shell-by-another-name nobody classified — the way
//      `run_tests` and `lint` shipped);
//   2. every tool in a peer-relay toolset (`delegation`, `a2a`) is in the
//      exclusion list or in RELAY_TOOLS_ALLOWED with its reason;
//   3. every name the exclusion list carries is registered by some profile or
//      named in NOT_COMPOSED (catches renames).
//
// Not covered: MCP tools (`mcp__<server>__<tool>`, `process: ['*']`) are named
// by the operator's servers, not by this repo — a documented limitation in the
// G-MEM register (docs/content/security/security-boundary.md).

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SHARED_AUDIENCE_EXCLUDED_TOOLS } from '@ethosagent/core';
import { createA2aTools } from '@ethosagent/tools-a2a';
import { createBrowserTools } from '@ethosagent/tools-browser';
import type { Tool } from '@ethosagent/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAgentLoop, type WiringConfig, type WiringProfile } from '../index';

/** Process-capable tools a shared turn may keep, and why each cannot read a host file. */
const PROCESS_TOOLS_ALLOWED: Record<string, string> = {};
const BROWSER_REASON =
  'drives a browser; navigation is refused for anything but http(s) (the protocol check in ' +
  'extensions/tools-browser), so no file:// read — `docker` is the optional sandboxed browser';
for (const name of [
  'browse_url',
  'browser_click',
  'browser_type',
  'browser_press',
  'browser_scroll',
  'browser_back',
  'browser_console',
  'browser_get_images',
  'browser_dialog',
  'browser_screenshot',
  'browser_vision_click',
  'browser_vision_type',
  'browser_computed_style',
  'browser_fill_credential',
  'browser_navigate',
]) {
  PROCESS_TOOLS_ALLOWED[name] = BROWSER_REASON;
}

/** Peer-relay-toolset tools a shared turn may keep, and why each is safe. */
const RELAY_TOOLS_ALLOWED: Record<string, string> = {
  delegate_task:
    'the child runs in-process and inherits the shared audience and the exclusion list ' +
    '(ToolContext.roomAudience / toolsetNarrowing.exclude)',
  mixture_of_agents: 'LLM-only fan-out inside this turn; no peer, no tools, no memory',
  list_team: 'reads the roster only',
  task_status: 'reads a background job this session started',
  task_result: 'reads a background job this session started',
  task_cancel: 'cancels a background job this session started',
  task_logs: 'reads a background job this session started',
  a2a_send:
    'an external A2A peer; an Ethos peer runs every inbound task shared (D13, ' +
    'apps/ethos/src/commands/serve-a2a-runner.ts)',
};

const RELAY_TOOLSETS = new Set(['delegation', 'a2a']);

/** Excluded names no single-process compose registers (team / meeting / mesh wiring). */
const NOT_COMPOSED = new Set([
  'team_memory_read',
  'team_memory_write',
  'team_memory_search',
  'meet_join',
  'route_to_agent',
  'dispatch_team',
  'broadcast_to_agents',
  'process_watch',
  'dashboard_add_panel',
  'dashboard_update_panel',
  'dashboard_import',
  'dashboard_set_params',
  'dashboard_export',
  'skills_pending_list',
  'skills_pending_view',
  'skills_pending_approve',
  'skills_pending_reject',
  'get_observability',
  'get_session_events',
  'session_list_by_date',
]);

const PROFILES: WiringProfile[] = ['cli', 'web'];

describe('shared-audience exclusion list covers every process-spawning and peer-relay tool', () => {
  let home: string;
  const tools = new Map<string, Tool>();
  const prevEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'ethos-shared-process-tools-'));
    const dataDir = join(home, '.ethos');
    mkdirSync(join(dataDir, 'personalities', 'open'), { recursive: true });
    writeFileSync(join(dataDir, 'personalities', 'open', 'config.yaml'), 'name: open\n');
    writeFileSync(join(dataDir, 'personalities', 'open', 'SOUL.md'), '# Core\nOpen.\n');
    // A narrow toolset keeps boot-time capability validation off tools this
    // test only reads; the enumeration below uses an undeclared toolset.
    writeFileSync(join(dataDir, 'personalities', 'open', 'toolset.yaml'), '- read_file\n');
    for (const key of ['HOME', 'ETHOS_STATE_DIR'] as const) prevEnv[key] = process.env[key];
    process.env.HOME = home;
    process.env.ETHOS_STATE_DIR = dataDir;
    const config: WiringConfig = {
      provider: 'ollama',
      model: 'offline-test',
      baseUrl: 'http://127.0.0.1:9',
      apiKey: 'sk-dummy',
      personality: 'open',
      memory: 'markdown',
    };
    for (const profile of PROFILES) {
      const runtime = await createAgentLoop(config, {
        dataDir,
        workingDir: home,
        disableDocker: true,
        profile,
      });
      try {
        // An undeclared toolset reaches every built-in tool.
        for (const name of runtime.toolRegistry.toolNamesForPersonality({
          id: 'open',
          name: 'open',
        })) {
          const tool = runtime.toolRegistry.get(name);
          if (tool) tools.set(name, tool);
        }
      } finally {
        await runtime.dispose();
      }
    }
    // Registered only by hosts this test cannot boot offline: the browser
    // (skipped under `disableDocker`) and A2A (`ethos serve` / `gateway`).
    // Their factories read no dependency at construction, as in
    // watcher-exfil-tool-names.test.ts.
    for (const tool of [
      ...createBrowserTools({}),
      ...createA2aTools({} as Parameters<typeof createA2aTools>[0]),
    ]) {
      tools.set(tool.name, tool);
    }
  }, 240_000);

  afterAll(() => {
    for (const [key, value] of Object.entries(prevEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(home, { recursive: true, force: true });
  });

  const excluded = new Set(SHARED_AUDIENCE_EXCLUDED_TOOLS);

  it('composes a real registry (the gate is not silently blind)', () => {
    expect(tools.size).toBeGreaterThan(40);
    expect(tools.has('terminal')).toBe(true);
    expect(tools.has('run_tests')).toBe(true);
  });

  it('every tool declaring capabilities.process is excluded or justified', () => {
    const unclassified = [...tools.values()]
      .filter((t) => t.capabilities.process !== undefined)
      .map((t) => t.name)
      .filter((name) => !excluded.has(name) && PROCESS_TOOLS_ALLOWED[name] === undefined);
    expect(
      unclassified,
      'add it to SHARED_AUDIENCE_EXCLUDED_TOOLS, or to PROCESS_TOOLS_ALLOWED with the reason it cannot read a host file',
    ).toEqual([]);
  });

  it('every peer-relay-toolset tool is excluded or justified', () => {
    const unclassified = [...tools.values()]
      .filter((t) => t.toolset !== undefined && RELAY_TOOLSETS.has(t.toolset))
      .map((t) => t.name)
      .filter((name) => !excluded.has(name) && RELAY_TOOLS_ALLOWED[name] === undefined);
    expect(unclassified).toEqual([]);
  });

  it('every excluded name is registered by a profile or named in NOT_COMPOSED', () => {
    const unknown = [...excluded].filter((name) => !tools.has(name) && !NOT_COMPOSED.has(name));
    expect(unknown).toEqual([]);
  });

  it('every justification names a registered tool (no stale entries)', () => {
    const stale = [
      ...Object.keys(PROCESS_TOOLS_ALLOWED),
      ...Object.keys(RELAY_TOOLS_ALLOWED),
    ].filter((name) => !tools.has(name));
    expect(stale).toEqual([]);
  });

  it('justifications do not shadow the exclusion list', () => {
    const both = [
      ...Object.keys(PROCESS_TOOLS_ALLOWED),
      ...Object.keys(RELAY_TOOLS_ALLOWED),
    ].filter((name) => excluded.has(name));
    expect(both).toEqual([]);
  });
});
