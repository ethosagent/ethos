// L9 of the initiative read-only enforcement map (plan initiative-engine, Task 2.8).
//
// One scripted turn through the REAL AgentLoop, built from `buildReadOnlyRegistry`
// and `ReadOnlyLoopParts`, calls every run tool once and tries the write tools a
// chat turn would have. A hash of every file under a temp Ethos home and a fake
// repo, taken before and after, may differ only by `initiatives.db*` (the ledger).
//
// Limit: the ledger here is an in-memory fake. `initiative-store` is not a wiring
// dependency, so the real SQLite ledger is not reachable from this package; the
// `initiatives.db*` allowance is kept so the diff rule matches the plan.

import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { SQLiteGoalStore } from '@ethosagent/goal-store';
import {
  createReadOnlyLoop,
  createReadOnlyLoopParts,
  readOnlyRunOptions,
  runToolNames,
} from '@ethosagent/initiative-runner';
import { KanbanStore } from '@ethosagent/kanban-store';
import { MarkdownFileMemoryProvider } from '@ethosagent/memory-markdown';
import { SQLiteSessionStore } from '@ethosagent/session-sqlite';
import { FsStorage } from '@ethosagent/storage-fs';
import type {
  AgentEvent,
  CompletionChunk,
  InitiativeLedgerPort,
  LLMProvider,
  PersonalityConfig,
} from '@ethosagent/types';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestSafety } from '../../../core/src/__tests__/helpers/test-safety';
import { buildReadOnlyRegistry, defaultInitiativeToolFactories } from '../initiatives';

/** In-memory ledger: records calls, touches no disk. */
function fakeLedger(): InitiativeLedgerPort {
  return {
    addIdea: (i) => ({ ...i, id: 'idea-1', createdAt: '2026-01-01T00:00:00Z' }),
    propose: (p) => ({
      id: 'exp-1',
      initiativeId: p.initiativeId,
      ideaId: p.ideaId,
      question: p.question,
      state: 'proposed',
      budgetUsd: 0,
      spentUsd: 0,
      deadline: '2026-01-02T00:00:00Z',
      estimateUsd: p.estimateUsd,
    }),
    proposeInitiativeDraft: () => ({ draftId: 'draft-1' }),
    addFinding: (f) => ({ ...f, id: 'f-1', createdAt: '2026-01-01T00:00:00Z' }),
    submitBrief: (b) => ({ ...b, id: 'b-1', version: 1 }),
    addQuestion: () => 'q-1',
    ideas: () => [],
    budget: () => ({ spentUsd: 0, capUsd: 1, explorationsOpen: 0 }),
  };
}

/** Every file under `roots`, keyed by path relative to `base`. */
function hashTree(base: string, roots: string[]): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        out.set(
          relative(base, full),
          createHash('sha256').update(readFileSync(full)).digest('hex'),
        );
      }
    }
  };
  for (const root of roots) walk(root);
  return out;
}

/** Paths added, removed or changed between two hashes. */
function diffHashes(before: Map<string, string>, after: Map<string, string>): string[] {
  const names = new Set([...before.keys(), ...after.keys()]);
  return [...names].filter((n) => before.get(n) !== after.get(n)).sort();
}

interface Call {
  name: string;
  input: Record<string, unknown>;
}

/** Scripted LLM: every call in one response, then a plain end_turn. */
function scriptedLLM(calls: Call[]): LLMProvider {
  let n = 0;
  return {
    name: 'scripted',
    model: 'mock-model',
    maxContextTokens: 200_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(): AsyncIterable<CompletionChunk> {
      n++;
      if (n > 1) {
        yield { type: 'text_delta', text: 'finished' };
        yield { type: 'done', finishReason: 'end_turn' };
        return;
      }
      for (const [i, c] of calls.entries()) {
        const id = `call-${i}`;
        const json = JSON.stringify(c.input);
        yield { type: 'tool_use_start', toolCallId: id, toolName: c.name };
        yield { type: 'tool_use_delta', toolCallId: id, partialJson: json };
        yield { type: 'tool_use_end', toolCallId: id, inputJson: json };
      }
      yield { type: 'done', finishReason: 'tool_use' };
    },
    async countTokens() {
      return 1;
    },
  };
}

describe('initiative run writes only the ledger (L9)', () => {
  let home: string;
  let dataDir: string;
  let repo: string;
  const stores: Array<{ close(): void }> = [];
  const prevEnv: Record<string, string | undefined> = {};

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'ethos-initiative-nowrites-'));
    dataDir = join(home, '.ethos');
    // A write to ~/.ethos or $ETHOS_STATE_DIR lands inside the hashed temp home, not the real one.
    for (const key of ['HOME', 'ETHOS_STATE_DIR'] as const) prevEnv[key] = process.env[key];
    process.env.HOME = home;
    process.env.ETHOS_STATE_DIR = dataDir;
    repo = join(home, 'repo');
    mkdirSync(join(dataDir, 'personalities', 'open'), { recursive: true });
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(dataDir, 'MEMORY.md'), '# Memory\nfact\n');
    writeFileSync(join(dataDir, 'personalities', 'open', 'config.yaml'), 'name: open\n');
    writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
    writeFileSync(join(repo, 'README.md'), '# fake repo\n');
  });

  afterEach(() => vi.unstubAllGlobals());

  afterAll(() => {
    for (const s of stores) s.close();
    for (const [key, value] of Object.entries(prevEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(home, { recursive: true, force: true });
  });

  it('R4 hash diff is the ledger only', async () => {
    const fetchSpy = vi.fn(async () => new Response('stubbed', { status: 503 }));
    vi.stubGlobal('fetch', fetchSpy);

    const storage = new FsStorage();
    const memory = new MarkdownFileMemoryProvider({ dir: dataDir, storage });
    const session = new SQLiteSessionStore(join(dataDir, 'sessions.db'));
    const kanbanStore = new KanbanStore(join(dataDir, 'kanban.db'));
    const goalStore = new SQLiteGoalStore(join(dataDir, 'goals.db'));
    for (const s of [session, kanbanStore, goalStore])
      stores.push(s as unknown as { close(): void });

    const seeded = kanbanStore.createTask({ title: 'seed task', roomAudience: 'shared' });

    const personality: PersonalityConfig = { id: 'open', name: 'open' };
    const registry = buildReadOnlyRegistry({
      personality,
      ledger: fakeLedger(),
      initiativeId: 'INI-1',
      sourcePaths: [repo],
      factories: defaultInitiativeToolFactories({
        env: {},
        toolsConfig: () => undefined,
        memory,
        session,
        kanbanStore,
        goalStore,
      }),
      storage,
      dataDir,
    });
    const runNames = registry.getAvailable().map((t) => t.name);
    expect(runNames.length).toBeGreaterThan(15);

    const args: Record<string, Record<string, unknown>> = {
      read_file: { path: join(repo, 'README.md') },
      search_files: { pattern: 'a', path: repo },
      web_extract: { url: 'http://169.254.169.254/latest/meta-data/' },
      web_search: { query: 'ethos' },
      memory_read: { store: 'memory' },
      session_search: { query: 'x' },
      session_list_by_date: { since: '2026-01-01' },
      kanban_list: {},
      kanban_show: { task_id: seeded.id },
      goal_status: {},
      initiative_note: { text: 'n' },
    };
    // Tools that must RUN and succeed with these args, so a validation failure cannot pass
    // as "called once". The initiative_* ledger tools are skeletons that answer
    // `not_available` until the ledger task lands (tools-initiatives/src/ledger-tools.ts),
    // so they are held only to "not an input-validation failure". web_* tools are
    // network-bound and stubbed/refused above.
    const mustSucceed = [
      'read_file',
      'search_files',
      'session_search',
      'kanban_list',
      'kanban_show',
      'goal_status',
    ];
    // An initiative run is incognito, so it is a shared-audience turn, and
    // SHARED_AUDIENCE_EXCLUDED_TOOLS (packages/core/src/agent-loop/audience.ts) hides these
    // two even though they are in INITIATIVE_READ_TOOLS. Pinned so a change is deliberate.
    const surfaceExcluded = ['memory_read', 'session_list_by_date'];
    const writeTries: Call[] = [
      { name: 'write_file', input: { path: join(repo, 'src', 'evil.ts'), content: 'x' } },
      { name: 'memory_write', input: { store: 'memory', content: 'evil', action: 'add' } },
      { name: 'send_message', input: { target: 'telegram', message: 'hi' } },
      { name: 'kanban_create', input: { title: 'evil' } },
      { name: 'initiative_define', input: { title: 'evil' } },
    ];
    const calls: Call[] = [
      ...runNames.map((name) => ({ name, input: args[name] ?? {} })),
      ...writeTries,
    ];

    const before = hashTree(home, [home]);

    const allowed = new Set(runToolNames(personality.toolset));
    const parts = createReadOnlyLoopParts({
      tools: registry,
      llm: scriptedLLM(calls),
      safety: createTestSafety(),
      allowed,
    });
    const loop = createReadOnlyLoop(parts);
    const events: AgentEvent[] = [];
    for await (const e of loop.run(
      'explore',
      readOnlyRunOptions({
        initiativeId: 'INI-1',
        windowId: 'W-1',
        abortSignal: new AbortController().signal,
      }),
    )) {
      events.push(e);
    }

    const after = hashTree(home, [home]);

    const ended = events.filter((e) => e.type === 'tool_end') as Array<
      Extract<AgentEvent, { type: 'tool_end' }>
    >;
    for (const name of runNames) {
      expect(
        ended.filter((e) => e.toolName === name),
        `run tool ${name} was called exactly once`,
      ).toHaveLength(1);
    }
    for (const name of mustSucceed) {
      const end = ended.find((e) => e.toolName === name);
      expect(end?.ok, `${name} ran with valid args: ${end?.error ?? ''}`).toBe(true);
    }
    for (const name of surfaceExcluded) {
      const end = ended.find((e) => e.toolName === name);
      expect(end?.error, `${name} is off the shared-audience surface`).toMatch(
        /not available on this surface/,
      );
    }
    for (const name of runNames.filter((n) => n.startsWith('initiative_'))) {
      const end = ended.find((e) => e.toolName === name);
      expect(end?.error ?? '', `${name} was not rejected as invalid input`).not.toMatch(
        /invalid|schema|required/i,
      );
    }
    for (const t of writeTries) {
      const end = ended.find((e) => e.toolName === t.name);
      expect(end?.ok, `${t.name} was refused`).toBe(false);
    }
    // The stubbed fetch never saw the metadata address (web_extract refuses it first).
    for (const [url] of fetchSpy.mock.calls as unknown as Array<[string | URL]>) {
      expect(String(url)).not.toContain('169.254.169.254');
    }

    // `*.db-shm` is SQLite's shared-memory wal-index: any reader of a WAL database
    // rewrites it, and it holds no data. The `.db` and `.db-wal` content must not move.
    const changed = diffHashes(before, after).filter(
      (p) => !/(^|\/)initiatives\.db/.test(p) && !p.endsWith('.db-shm'),
    );
    expect(changed).toEqual([]);
  }, 60_000);
});
