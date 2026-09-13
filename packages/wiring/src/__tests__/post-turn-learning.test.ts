// M-T3 / M-D6 (plan/phases/trust-before-reach.md Part 3) —
// `disablePostTurnLearning` is a security property, not a preference: in a
// process whose turns are driven by an EXTERNAL MCP client, a post-turn
// learner turns that client's text into the operator's skills and memory with
// nobody in the loop.
//
// Both learners hang off ONE seam — a void `agent_done` hook
// (`ImprovementFork.register`, `MemoryCaptureRunner.registerHook`) — so the
// honest test is to count what `createAgentLoop` registers on that seam. The
// count is taken at the registry itself (`DefaultHookRegistry.prototype`), not
// from a list of names, so a THIRD learner added later is caught by the same
// assertion rather than slipping past a hand-maintained roster.
//
// Driven through the real composition root, offline: HOME and ETHOS_STATE_DIR
// point at a temp dir, the provider baseUrl is a closed port, and both runtimes
// are disposed.

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DefaultHookRegistry } from '@ethosagent/core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { type CreateAgentLoopOptions, createAgentLoop, type WiringConfig } from '../index';

let home: string;
let dataDir: string;
const prevEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'ethos-post-turn-learning-'));
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

/** Offline, with proactive capture ON so both learners would wire themselves. */
function config(): WiringConfig {
  return {
    provider: 'ollama',
    model: 'offline-test',
    baseUrl: 'http://127.0.0.1:9',
    apiKey: 'sk-dummy',
    memory: 'markdown',
    memoryCapture: { enabled: true },
  };
}

/**
 * Count `agent_done` void-hook registrations made while one runtime is
 * assembled. Returns the count and the assembled runtime's own facts.
 */
async function assemble(opts: Partial<CreateAgentLoopOptions>) {
  const spy = vi.spyOn(DefaultHookRegistry.prototype, 'registerVoid');
  try {
    const runtime = await createAgentLoop(config(), {
      dataDir,
      workingDir: home,
      disableDocker: true,
      profile: 'cli',
      ...opts,
    });
    const agentDone = spy.mock.calls.filter(([name]) => name === 'agent_done').length;
    return { runtime, agentDone };
  } finally {
    spy.mockRestore();
  }
}

describe('disablePostTurnLearning (M-D6)', () => {
  it('registers agent_done learners by default, and NONE under the flag', async () => {
    const baseline = await assemble({});
    try {
      // Sanity: without the flag the seam is live, so the assertion below is
      // about the flag and not about a runtime that wires nothing anyway.
      expect(baseline.agentDone).toBeGreaterThan(0);
      // `onMemoryCaptured` is present ONLY when the capture runner was built,
      // so this pins that BOTH learners were in play in the baseline — not just
      // the improvement fork.
      expect(baseline.runtime.onMemoryCaptured).toBeDefined();
    } finally {
      await baseline.runtime.dispose();
    }

    const exported = await assemble({ profile: 'mcp', disablePostTurnLearning: true });
    try {
      expect(exported.agentDone).toBe(0);
      expect(exported.runtime.onMemoryCaptured).toBeUndefined();
    } finally {
      await exported.runtime.dispose();
    }
  }, 120_000);

  // Assembling under `profile: 'mcp'` at all is the other half of M-T3 item 1:
  // wiring passes the profile through as `AgentLoop.options.platform`
  // (`build-agent-loop.ts`, `options: { platform: profile }`), and a turn stamps
  // it on the session it creates (`createSession({ platform: deps.platform })`,
  // Step 1 of `packages/core/src/agent-loop/stages/turn-setup.ts`) — which is
  // what makes an externally-driven conversation distinguishable in sessions.db.
  it('assembles under the mcp profile and exposes its own personality registry', async () => {
    const { runtime } = await assemble({ profile: 'mcp', disablePostTurnLearning: true });
    try {
      // M-D13 — the export server re-reads the declaration per call from THIS
      // registry (the one `refreshPersonalities()` reloads), never one it
      // builds itself.
      expect(runtime.personalities.getDefault().id).toBe(runtime.activePersonality.id);
      expect(runtime.personalities.get(runtime.activePersonality.id)?.id).toBe(
        runtime.activePersonality.id,
      );
      await runtime.refreshPersonalities();
      expect(runtime.personalities.list().length).toBeGreaterThan(0);
    } finally {
      await runtime.dispose();
    }
  }, 120_000);
});
