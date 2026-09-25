// Command substitution (`$(…)`, backticks) requires approval; it is not
// hardline. On a non-web loop the terminal/process guards `composeAllTools`
// registers refuse it unless the host has marked the loop as carrying an
// approval gate (`markHostApprovalGate`) — CLI, TUI and ACP have no gate, so
// they stay fail-closed. Drives the REAL composition root against a throwaway
// `~/.ethos`, so the assertion is on the guards actually registered, not on a
// hand-built copy of them.

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BeforeToolCallPayload } from '@ethosagent/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAgentLoop, markHostApprovalGate, type WiringConfig } from '../index';

let home: string;
let dataDir: string;
const prevEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'ethos-subst-guard-'));
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

const CONFIG: WiringConfig = {
  provider: 'anthropic',
  model: 'claude-sonnet-4-5',
  apiKey: 'sk-test',
};

const call = (toolName: string, command: string): BeforeToolCallPayload => ({
  sessionId: 's',
  toolCallId: 'tc',
  toolName,
  args: { command },
});

describe('composed guards — command substitution on a non-web loop', () => {
  it('CLI (no approval gate): refused for terminal, run_tests, lint and process_start', async () => {
    const runtime = await createAgentLoop(CONFIG, {
      dataDir,
      workingDir: home,
      profile: 'cli',
      disableDocker: true,
    });
    try {
      for (const tool of ['terminal', 'run_tests', 'lint', 'process_start']) {
        const result = await runtime.loop.hooks.fireModifying(
          'before_tool_call',
          call(tool, 'kill $(lsof -t -i:3000)'),
        );
        expect(result.error).toMatch(/command substitution requires explicit human approval/);
      }
    } finally {
      await runtime.dispose();
    }
  });

  it('a loop marked as carrying a host approval gate: the guards defer; bash -c stays refused', async () => {
    const runtime = await createAgentLoop(CONFIG, {
      dataDir,
      workingDir: home,
      profile: 'cli',
      disableDocker: true,
    });
    try {
      markHostApprovalGate(runtime.loop.hooks);
      for (const tool of ['terminal', 'process_start']) {
        const deferred = await runtime.loop.hooks.fireModifying(
          'before_tool_call',
          call(tool, 'kill $(lsof -t -i:3000)'),
        );
        expect(deferred.error).toBeUndefined();
        const hardline = await runtime.loop.hooks.fireModifying(
          'before_tool_call',
          call(tool, "bash -c 'id'"),
        );
        expect(hardline.error).toMatch(/inline shell eval/);
      }
    } finally {
      await runtime.dispose();
    }
  });
});
