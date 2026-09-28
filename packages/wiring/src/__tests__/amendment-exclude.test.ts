// plan personality-memory-boundary G2 — `propose_self_amendment` is registered
// by the composition root (`composeAllTools`, packages/wiring/src/compose-tools.ts)
// and is opt-in twice: the intake refuses a personality whose toolset does not
// list it (propose-amendment.test.ts), and `buildPersonalityToolExclude`
// (build-agent-loop.ts) hides it from every such personality. The prefix
// invariant: a personality with an UNDECLARED toolset (it sees every registered
// tool) gets byte-identical tool definitions and system prompt whether or not
// the tool is registered.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentLoop, DefaultPersonalityRegistry, DefaultToolRegistry } from '@ethosagent/core';
import { listAmendments } from '@ethosagent/learning-inbox';
import {
  c2PatternCheck,
  DOWNGRADE_REJECTION_MESSAGE,
  INJECTION_DEFENSE_PRELUDE,
  resolveDowngradedTools,
  sanitize,
  shortPatternCheck,
  wrapUntrusted,
} from '@ethosagent/safety-injection';
import { detectSecrets, redactPii, redactString } from '@ethosagent/safety-redact';
import { defaultAlwaysDeny, FsStorage, ScopedStorage } from '@ethosagent/storage-fs';
import {
  createProposeSelfAmendmentTool,
  PROPOSE_SELF_AMENDMENT_TOOL,
} from '@ethosagent/tools-personality-design';
import type {
  AgentSafety,
  CompletionChunk,
  CompletionOptions,
  LLMProvider,
  PersonalityConfig,
  Tool,
  ToolContext,
  ToolDefinitionLite,
} from '@ethosagent/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildPersonalityToolExclude } from '../build-agent-loop';
import { createAgentLoop, type WiringConfig } from '../index';

describe('buildPersonalityToolExclude', () => {
  const exclude = buildPersonalityToolExclude(undefined);

  it('hides the tool from a personality that does not list it, declared or not', () => {
    expect(exclude({ id: 'open', name: 'Open' })).toEqual([PROPOSE_SELF_AMENDMENT_TOOL]);
    expect(exclude({ id: 'lean', name: 'Lean', toolset: ['read_file'] })).toEqual([
      PROPOSE_SELF_AMENDMENT_TOOL,
    ]);
  });

  it('shows it to a personality that lists it', () => {
    expect(
      exclude({ id: 'in', name: 'In', toolset: ['read_file', PROPOSE_SELF_AMENDMENT_TOOL] }),
    ).toEqual([]);
  });

  it('keeps hiding `decide` from a personality without the operator decision model', () => {
    const withDecisions = buildPersonalityToolExclude({ provider: 'typesafe' });
    expect(withDecisions({ id: 'plain', name: 'Plain' })).toEqual([
      'decide',
      PROPOSE_SELF_AMENDMENT_TOOL,
    ]);
  });
});

// --- prefix invariant --------------------------------------------------------

function capturingLLM(seen: Array<{ system: string; tools: ToolDefinitionLite[] }>): LLMProvider {
  return {
    name: 'capture',
    model: 'mock-model',
    maxContextTokens: 200_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(
      _m: unknown,
      tools: ToolDefinitionLite[],
      opts: CompletionOptions,
    ): AsyncIterable<CompletionChunk> {
      seen.push({ system: JSON.stringify(opts.system ?? null), tools });
      yield { type: 'text_delta', text: 'ok' };
      yield { type: 'done', finishReason: 'end_turn' };
    },
    async countTokens() {
      return 1;
    },
  };
}

function safety(): AgentSafety {
  return {
    injection: {
      prelude: INJECTION_DEFENSE_PRELUDE,
      downgradeRejectionMessage: DOWNGRADE_REJECTION_MESSAGE,
      sanitize,
      wrapUntrusted,
      shortPatternCheck,
      c2PatternCheck,
      resolveDowngradedTools,
    },
    redaction: { redactPii, redactString, detectSecrets },
    scopedStorageFactory: (base, scope) =>
      new ScopedStorage(base, { ...scope, alwaysDeny: defaultAlwaysDeny() }),
    approvalPosture: { kind: 'ungated', reason: 'test fixture — no approval policy' },
  };
}

function plainTool(name: string): Tool {
  return {
    name,
    description: `tool ${name}`,
    schema: { type: 'object' },
    capabilities: {},
    execute: async () => ({ ok: true, value: 'ok' }),
  };
}

async function firstRequest(
  person: PersonalityConfig,
  registerAmendmentTool: boolean,
): Promise<{ system: string; tools: ToolDefinitionLite[] }> {
  const seen: Array<{ system: string; tools: ToolDefinitionLite[] }> = [];
  const personalities = new DefaultPersonalityRegistry();
  personalities.define(person);
  const tools = new DefaultToolRegistry();
  tools.register(plainTool('read_file'));
  tools.register(plainTool('web_search'));
  if (registerAmendmentTool) {
    tools.register(
      createProposeSelfAmendmentTool({ submit: async () => ({ ok: false, reason: 'test' }) }),
    );
  }
  const loop = new AgentLoop({
    llm: capturingLLM(seen),
    tools,
    personalities,
    safety: safety(),
    personalityToolExclude: buildPersonalityToolExclude(undefined),
  });
  for await (const _ of loop.run('hello', { personalityId: person.id, sessionKey: 'cli:p' })) {
    // drain to exhaustion
  }
  const first = seen[0];
  if (!first) throw new Error('no LLM request captured');
  return first;
}

describe('prefix invariant', () => {
  it('an undeclared-toolset personality sees byte-identical tools and system prompt', async () => {
    const open: PersonalityConfig = { id: 'open', name: 'Open' };
    const without = await firstRequest(open, false);
    const withTool = await firstRequest(open, true);
    expect(JSON.stringify(withTool.tools)).toBe(JSON.stringify(without.tools));
    expect(withTool.system).toBe(without.system);
    expect(withTool.tools.map((t) => t.name)).not.toContain(PROPOSE_SELF_AMENDMENT_TOOL);
  });

  it('an opted-in personality sees the tool', async () => {
    const opted = await firstRequest(
      { id: 'opted', name: 'Opted', toolset: ['read_file', PROPOSE_SELF_AMENDMENT_TOOL] },
      true,
    );
    expect(opted.tools.map((t) => t.name).sort()).toEqual([
      PROPOSE_SELF_AMENDMENT_TOOL,
      'read_file',
    ]);
  });
});

// --- registration through the composition root -------------------------------

describe('composeAllTools registers propose_self_amendment', () => {
  const OPTED = 'amender';
  const OPTED_TOOLSET = `- read_file\n- ${PROPOSE_SELF_AMENDMENT_TOOL}\n`;
  let home: string;
  let dataDir: string;
  let runtime: Awaited<ReturnType<typeof createAgentLoop>>;
  const prevEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'ethos-amendment-exclude-'));
    dataDir = join(home, '.ethos');
    const dir = join(dataDir, 'personalities', OPTED);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'config.yaml'), `name: ${OPTED}\n`);
    writeFileSync(join(dir, 'SOUL.md'), '# Core\nI amend.\n');
    writeFileSync(join(dir, 'toolset.yaml'), OPTED_TOOLSET);
    for (const key of ['HOME', 'ETHOS_STATE_DIR'] as const) prevEnv[key] = process.env[key];
    process.env.HOME = home;
    process.env.ETHOS_STATE_DIR = dataDir;
    const config: WiringConfig = {
      provider: 'ollama',
      model: 'offline-test',
      baseUrl: 'http://127.0.0.1:9',
      apiKey: 'sk-dummy',
      personality: OPTED,
      memory: 'markdown',
    };
    runtime = await createAgentLoop(config, {
      dataDir,
      workingDir: home,
      disableDocker: true,
      profile: 'cli',
    });
  }, 120_000);

  afterAll(async () => {
    await runtime?.dispose();
    for (const [key, value] of Object.entries(prevEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(home, { recursive: true, force: true });
  });

  it('the registered tool files through the wired intake and leaves toolset.yaml untouched', async () => {
    const tool = runtime.toolRegistry.get(PROPOSE_SELF_AMENDMENT_TOOL);
    expect(tool?.toolset).toBe('self_amendment');
    const ctx = {
      sessionId: 'no-such-session',
      sessionKey: 'cli:amendment-exclude',
      platform: 'cli',
      personalityId: OPTED,
      initiator: 'user',
      roomAudience: 'private',
      workingDir: home,
      currentTurn: 1,
      messageCount: 1,
      abortSignal: new AbortController().signal,
      emit: () => {},
      resultBudgetChars: 80_000,
    } as ToolContext;
    const result = await tool?.execute(
      { ops: [{ op: 'add_tool', tool: 'web_search' }], rationale: 'searches were refused' },
      ctx,
    );
    expect(result).toEqual({ ok: true, value: expect.any(String) });
    const [record] = await listAmendments(new FsStorage(), dataDir);
    expect(record).toMatchObject({ personalityId: OPTED, status: 'pending' });
    expect(readFileSync(join(dataDir, 'personalities', OPTED, 'toolset.yaml'), 'utf-8')).toBe(
      OPTED_TOOLSET,
    );
  });

  it('the loop hides it from any personality whose toolset does not list it', () => {
    const exclude = Reflect.get(runtime.loop, 'personalityToolExclude') as (
      p: PersonalityConfig,
    ) => string[];
    const opted = runtime.personalities.get(OPTED);
    if (!opted) throw new Error('amender not loaded');
    expect(exclude(opted)).toEqual([]);
    expect(exclude({ id: 'open', name: 'Open' })).toEqual([PROPOSE_SELF_AMENDMENT_TOOL]);
  });
});
