// L-T3 (plan/phases/trust-before-reach.md Part 4, Design section 3) — a replay
// is a MEASUREMENT, not a run. This is the acceptance test the rest of Part 4
// stands on, so it is driven through the REAL composition root
// (`createReplayLoop` → `createAgentLoop`) against a REAL personality on disk
// and a stub LLM over loopback HTTP. Nothing here is a unit test of a mock.
//
// The five things it pins, and the enforcer for each (rule 12):
//   1. no write lands under `dataDir` — `OverlayStorage` refuses every write
//      (`extensions/learning-inbox/src/overlay-storage.ts`), and it is what
//      `WiringContext.storage` and `AgentLoopConfig.storage` both are under
//      `CreateAgentLoopOptions.replay`;
//   2. a spy tool's `execute` is never called — `RunOptions.dryRun`, i.e.
//      `DefaultToolRegistry.executeParallel` returning `synthesizeDryRunResult`
//      (`packages/core/src/tool-registry.ts`);
//   3. a gated `send_message` in the dry-run plan creates no outbox row (X-D6) —
//      the same enforcer, because the gate lives INSIDE `executeSendMessage`
//      (`extensions/tools-messaging/src/index.ts`, O-D3), which never runs. The
//      overlay cannot cover this: `outbox.db` is a raw SQLite path;
//   4. the SHADOWED SOUL bytes reach the model — proving the overlay is what
//      the loop actually reads, not a decoration beside it;
//   5. no `agent_done` fork is registered — `disablePostTurnLearning`, forced on
//      by `createAgentLoop` for every replay.

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { DefaultHookRegistry } from '@ethosagent/core';
import { serializeLivingSoul } from '@ethosagent/personalities';
import { FsStorage } from '@ethosagent/storage-fs';
import type { AgentEvent, Tool, ToolResult } from '@ethosagent/types';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { OutboxWiring } from '../compose-tools';
import { createAgentLoop, type WiringConfig } from '../index';
import { createReplayLoop, REPLAY_RUN_OPTIONS, shadowForCandidate } from '../learning-replay';

// --- the personality under measurement --------------------------------------

const PERSONALITY = 'replayer';
const CORE = 'I am the replay fixture. CORE-SENTINEL-KEEP.\n';
const LIVE_EXPRESSION = 'I speak in the LIVE-EXPRESSION-ON-DISK voice.\n';
const CANDIDATE_EXPRESSION = 'I speak in the SHADOW-EXPRESSION-CANDIDATE voice.\n';

let home: string;
let dataDir: string;
let soulFile: string;
let server: Server;
let baseUrl: string;
const prevEnv: Record<string, string | undefined> = {};

/** Request bodies the stub LLM received, newest last. */
let requests: { system: string; body: unknown }[] = [];

// --- the stub LLM -----------------------------------------------------------
//
// Loopback HTTP rather than a mocked provider: the turn must go through the
// real OpenAI-compat serialization, because assertion 4 is about what actually
// reaches the wire as the system prompt.

function sse(chunks: unknown[]): string {
  return `${chunks.map((c) => `data: ${JSON.stringify(c)}\n`).join('\n')}\ndata: [DONE]\n\n`;
}

const TOOL_CALL_TURN = sse([
  {
    id: 'chatcmpl-replay',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'gpt-4o',
    choices: [
      {
        index: 0,
        delta: {
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: 'call_spy',
              type: 'function',
              function: { name: 'spy_tool', arguments: '{}' },
            },
          ],
        },
        finish_reason: null,
      },
    ],
  },
  {
    id: 'chatcmpl-replay',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'gpt-4o',
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index: 1,
              id: 'call_send',
              type: 'function',
              function: {
                name: 'send_message',
                arguments: JSON.stringify({
                  platform: 'telegram',
                  target: '99999',
                  body: 'a measurement must never reach a human',
                }),
              },
            },
          ],
        },
        finish_reason: null,
      },
    ],
  },
  {
    id: 'chatcmpl-replay',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'gpt-4o',
    choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  },
]);

const MEMORY_WRITE_TURN = sse([
  {
    id: 'chatcmpl-replay',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'gpt-4o',
    choices: [
      {
        index: 0,
        delta: {
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: 'call_mem',
              type: 'function',
              function: {
                name: 'memory_write',
                arguments: JSON.stringify({
                  store: 'memory',
                  action: 'add',
                  content: 'A MEASUREMENT MUST NOT BE REMEMBERED',
                }),
              },
            },
          ],
        },
        finish_reason: null,
      },
    ],
  },
  {
    id: 'chatcmpl-replay',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'gpt-4o',
    choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  },
]);

const TEXT_TURN = sse([
  {
    id: 'chatcmpl-replay',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'gpt-4o',
    choices: [{ index: 0, delta: { role: 'assistant', content: 'measured' }, finish_reason: null }],
  },
  {
    id: 'chatcmpl-replay',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'gpt-4o',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 2 },
  },
]);

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'ethos-replay-isolation-'));
  dataDir = join(home, '.ethos');
  const personalityDir = join(dataDir, 'personalities', PERSONALITY);
  mkdirSync(personalityDir, { recursive: true });
  mkdirSync(join(dataDir, 'skills'), { recursive: true });
  soulFile = join(personalityDir, 'SOUL.md');
  writeFileSync(
    soulFile,
    serializeLivingSoul({ core: CORE, expression: LIVE_EXPRESSION, learningLog: [] }),
  );
  writeFileSync(
    join(personalityDir, 'config.yaml'),
    [
      'name: Replayer',
      'description: A fixture personality used to measure replay isolation.',
      'model: gpt-4o',
      // O-D3 — what makes the `send_message` assertion mean something: with no
      // policy the gate would not fire even outside a replay.
      'outbound_policy.approve_before_send: true',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(personalityDir, 'toolset.yaml'),
    '- send_message\n- spy_tool\n- memory_write\n',
  );
  // The operator's messaging allowlist. Without it `executeSendMessage` refuses
  // the target BEFORE the outbox gate reaches it (O-D3 ordering), and the "no
  // outbox row" assertion would pass for the wrong reason. The control is the
  // last test in this file: the same turn, without `replay`, queues exactly one
  // proposal and executes the spy tool.
  writeFileSync(
    join(dataDir, 'messaging.json'),
    JSON.stringify({ [PERSONALITY]: ['telegram:99999'] }),
  );

  for (const key of ['HOME', 'ETHOS_STATE_DIR'] as const) prevEnv[key] = process.env[key];
  process.env.HOME = home;
  process.env.ETHOS_STATE_DIR = dataDir;

  server = createServer((req, res) => {
    if (!req.url?.endsWith('/chat/completions')) {
      res.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        messages: { role: string; content: unknown }[];
      };
      const system = body.messages
        .filter((m) => m.role === 'system')
        .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
        .join('\n');
      requests.push({ system, body });
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
      });
      // Scripted by what the turn asked for, and by whether tool results are
      // already in the transcript: the FIRST call of a turn asks for tools, the
      // next one ends it.
      const asked = JSON.stringify(body.messages);
      const firstCall = !asked.includes('"tool"');
      if (!firstCall) {
        res.end(TEXT_TURN);
        return;
      }
      res.end(asked.includes('remember this') ? MEMORY_WRITE_TURN : TOOL_CALL_TURN);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}/v1`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const [key, value] of Object.entries(prevEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true });
});

function config(): WiringConfig {
  return {
    // A HOSTED alias with a loopback baseUrl: `classifyLocalRuntime` never
    // reclassifies a hosted name by port (`runtime-classify.ts` rule 2), so the
    // turn takes the ordinary native-tool-call path, not a local-runtime one.
    provider: 'openai',
    model: 'gpt-4o',
    apiKey: 'sk-dummy',
    baseUrl,
    personality: PERSONALITY,
    memory: 'markdown',
    // On, so the read-only memory wrapper is actually exercised rather than
    // being unreachable in this fixture.
    memoryCapture: { enabled: true },
  } as WiringConfig;
}

/** `sha256` of every file under `dir`, keyed by its path relative to `dir`. */
function treeDigest(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile()) {
        out.set(relative(dir, p), createHash('sha256').update(readFileSync(p)).digest('hex'));
      }
    }
  };
  walk(dir);
  return out;
}

function spyTool(onExecute: () => void): Tool {
  return {
    name: 'spy_tool',
    description: 'Records that it was executed. A replay must never execute it.',
    toolset: 'debug',
    capabilities: {},
    schema: { type: 'object', properties: {} },
    async execute(): Promise<ToolResult> {
      onExecute();
      return { ok: true, value: 'the spy tool ran — which under dry-run it must not' };
    },
  };
}

describe('replay isolation (L-T3)', () => {
  it('runs a measured turn that writes nothing, executes nothing, and queues nothing', async () => {
    requests = [];
    let executed = 0;
    const proposals: unknown[] = [];
    const outbox: OutboxWiring = {
      ownerTarget: () => undefined,
      propose: async (p) => {
        proposals.push(p);
        return { ok: true, itemId: 'obx_1', revision: 1 };
      },
    };

    // The candidate: the SAME personality, a different Expression. Core and the
    // learning log come off disk unchanged (`shadowForCandidate`).
    const shadow = await shadowForCandidate(
      { kind: 'expression', destination: soulFile, content: CANDIDATE_EXPRESSION },
      { storage: new FsStorage() },
    );

    const registerVoid = vi.spyOn(DefaultHookRegistry.prototype, 'registerVoid');
    const runtime = await createReplayLoop(config(), {
      dataDir,
      workingDir: home,
      shadow,
      outbox,
    });
    const agentDoneHooks = registerVoid.mock.calls.filter(([name]) => name === 'agent_done').length;
    registerVoid.mockRestore();

    try {
      runtime.toolRegistry.register(spyTool(() => executed++));

      // Snapshot AFTER assembly: assembling ANY loop opens `sessions.db` and
      // its siblings through raw SQLite, which no `Storage` can police (the
      // limitation `overlay-storage.ts` records). What the overlay DOES cover
      // is everything the turn itself would write — which is what this
      // measures.
      const before = treeDigest(dataDir);

      const events: AgentEvent[] = [];
      for await (const ev of runtime.loop.run('summarise the situation', {
        ...REPLAY_RUN_OPTIONS,
        sessionKey: 'replay:cand_1:candidate:case_1',
        dryRunMaxToolCalls: 8,
      })) {
        events.push(ev);
      }

      const after = treeDigest(dataDir);

      // 1 — no write lands under dataDir.
      expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
      for (const [path, digest] of after) {
        expect(`${path}:${digest}`).toBe(`${path}:${before.get(path)}`);
      }

      // The turn actually happened — otherwise every assertion below is
      // vacuously true.
      const done = events.find((e) => e.type === 'done');
      expect(done).toBeDefined();
      const plan = events.find((e) => e.type === 'dry_run_summary');
      expect(plan?.type === 'dry_run_summary' && plan.plan.map((p) => p.toolName)).toEqual([
        'spy_tool',
        'send_message',
      ]);

      // 2 — the spy tool was planned but never executed.
      expect(executed).toBe(0);

      // 3 — X-D6: a gated `send_message` in the plan queues no outbox row.
      expect(proposals).toEqual([]);

      // 4 — the SHADOWED soul is what the model saw, Core included and the
      // on-disk Expression gone.
      const system = requests.map((r) => r.system).join('\n');
      expect(system).toContain('SHADOW-EXPRESSION-CANDIDATE');
      expect(system).toContain('CORE-SENTINEL-KEEP');
      expect(system).not.toContain('LIVE-EXPRESSION-ON-DISK');
      // And the file on disk still says what it always said.
      expect(readFileSync(soulFile, 'utf8')).toContain('LIVE-EXPRESSION-ON-DISK');

      // 5 — no post-turn learner was wired: a replay never feeds learning.
      expect(agentDoneHooks).toBe(0);
      expect(runtime.onMemoryCaptured).toBeUndefined();
    } finally {
      await runtime.dispose();
    }
  }, 120_000);

  it('gives the baseline arm the same refusal, with the live bytes', async () => {
    requests = [];
    const runtime = await createReplayLoop(config(), {
      dataDir,
      workingDir: home,
      shadow: null,
    });
    try {
      const before = treeDigest(dataDir);
      const events: AgentEvent[] = [];
      for await (const ev of runtime.loop.run('summarise the situation', {
        ...REPLAY_RUN_OPTIONS,
        sessionKey: 'replay:cand_1:baseline:case_1',
        dryRunMaxToolCalls: 8,
      })) {
        events.push(ev);
      }
      expect(events.some((e) => e.type === 'done')).toBe(true);

      const after = treeDigest(dataDir);
      expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
      for (const [path, digest] of after) {
        expect(`${path}:${digest}`).toBe(`${path}:${before.get(path)}`);
      }

      // The baseline measures what is LIVE — no shadow, so the on-disk
      // Expression is exactly what reaches the model.
      const system = requests.map((r) => r.system).join('\n');
      expect(system).toContain('LIVE-EXPRESSION-ON-DISK');
      expect(system).not.toContain('SHADOW-EXPRESSION-CANDIDATE');
    } finally {
      await runtime.dispose();
    }
  }, 120_000);

  // The skill half of "the shadow is what the model reads". A CREATE is the
  // hard case: the file is not on disk at all, so it reaches the model only if
  // `listEntries` synthesizes the entry `UniversalScanner.discoverFiles` walks.
  it('makes a CREATED skill candidate visible to the scanner and the prompt', async () => {
    requests = [];
    const destination = join(dataDir, 'skills', 'shadow-summarise.md');
    const shadow = await shadowForCandidate(
      {
        kind: 'skill',
        destination,
        content: [
          '---',
          'name: shadow-summarise',
          'description: SHADOW-SKILL-DESCRIPTION — summarise a long document.',
          '---',
          '',
          'SHADOW-SKILL-BODY',
          '',
        ].join('\n'),
      },
      { storage: new FsStorage() },
    );
    const runtime = await createReplayLoop(config(), {
      dataDir,
      workingDir: home,
      shadow,
    });
    try {
      const before = treeDigest(dataDir);
      for await (const _ of runtime.loop.run('summarise the situation', {
        ...REPLAY_RUN_OPTIONS,
        sessionKey: 'replay:cand_2:candidate:case_1',
        dryRunMaxToolCalls: 8,
      })) {
        // Drain to exhaustion.
      }
      const system = requests.map((r) => r.system).join('\n');
      expect(system).toContain('shadow-summarise');
      expect(system).toContain('SHADOW-SKILL-DESCRIPTION');

      // And the candidate never landed on disk.
      const after = treeDigest(dataDir);
      expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
      expect(existsSync(destination)).toBe(false);
    } finally {
      await runtime.dispose();
    }
  }, 120_000);

  // The read-only memory wrapper's own test. A replay as L-T4 runs it never
  // gets here — `dryRun` means no tool executes at all — so the arm is driven
  // WITHOUT `dryRun` on purpose, which is the only way to reach the one caller
  // of `memory.sync` (`memory_write`, `extensions/tools-memory/src/index.ts`).
  // Without the wrapper this call reaches the markdown backend, which mkdirs
  // and writes through the overlay: the tool would come back `ok: false` with a
  // `BoundaryError`. With it, the write is a silent no-op — the shape a
  // measurement wants.
  it('makes a memory_write that DOES run a no-op, not a failure', async () => {
    requests = [];
    const runtime = await createReplayLoop(config(), {
      dataDir,
      workingDir: home,
      shadow: null,
    });
    try {
      const before = treeDigest(dataDir);
      const events: AgentEvent[] = [];
      for await (const ev of runtime.loop.run('remember this for me', {
        temperature: 0,
        sessionKey: 'replay:cand_1:memory:case_1',
      })) {
        events.push(ev);
      }
      const end = events.find((e) => e.type === 'tool_end' && e.toolName === 'memory_write');
      expect(end).toBeDefined();
      expect(end?.type === 'tool_end' && end.ok).toBe(true);

      const after = treeDigest(dataDir);
      expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
      for (const [path, digest] of after) {
        expect(`${path}:${digest}`).toBe(`${path}:${before.get(path)}`);
      }
    } finally {
      await runtime.dispose();
    }
  }, 120_000);

  // The control for every assertion above. Without it they could all pass on a
  // turn that was never going to write, execute or queue anything — so the SAME
  // turn runs one more time with no `replay` and no `dryRun`, and must do all
  // three. Last in the file on purpose: it is the only test here that leaves
  // state behind.
  it('CONTROL — the same turn without replay writes, executes and queues', async () => {
    requests = [];
    let executed = 0;
    const proposals: unknown[] = [];
    const runtime = await createAgentLoop(config(), {
      dataDir,
      workingDir: home,
      disableDocker: true,
      outbox: {
        ownerTarget: () => undefined,
        propose: async (p) => {
          proposals.push(p);
          return { ok: true, itemId: 'obx_1', revision: 1 };
        },
      },
    });
    try {
      runtime.toolRegistry.register(spyTool(() => executed++));
      const before = treeDigest(dataDir);
      for await (const _ of runtime.loop.run('summarise the situation', {
        sessionKey: 'cli:control',
      })) {
        // Drain to exhaustion — `done` is the answer, not the end of the turn.
      }
      const after = treeDigest(dataDir);
      expect([...after.entries()]).not.toEqual([...before.entries()]);
      expect(executed).toBe(1);
      expect(proposals).toHaveLength(1);
    } finally {
      await runtime.dispose();
    }
  }, 120_000);
});

describe('shadowForCandidate', () => {
  it('keeps Core and the learning log byte-identical and replaces only Expression', async () => {
    const shadow = await shadowForCandidate(
      { kind: 'expression', destination: soulFile, content: CANDIDATE_EXPRESSION },
      { storage: new FsStorage() },
    );
    expect(shadow.path).toBe(soulFile);
    expect(shadow.content).toBe(
      serializeLivingSoul({ core: CORE, expression: CANDIDATE_EXPRESSION, learningLog: [] }),
    );
    expect(shadow.content).toContain(CORE);
  });

  it('shadows a skill candidate at its destination, verbatim', async () => {
    const destination = join(dataDir, 'skills', 'summarise.md');
    const shadow = await shadowForCandidate(
      { kind: 'skill', destination, content: '# Summarise\nthe candidate body\n' },
      { storage: new FsStorage() },
    );
    expect(shadow).toEqual({ path: destination, content: '# Summarise\nthe candidate body\n' });
  });

  it('refuses an Expression candidate whose soul file does not exist', async () => {
    await expect(
      shadowForCandidate(
        { kind: 'expression', destination: join(dataDir, 'nope', 'SOUL.md'), content: 'x' },
        { storage: new FsStorage() },
      ),
    ).rejects.toThrow(/does not exist/);
  });
});
