// Task 6.1 (plan world-model): the `routeFact` seam. memory-capture never imports
// world-service; the seam is a plain callback, so these tests use a stub router.

import { HistoryStore } from '@ethosagent/memory-history';
import { MarkdownFileMemoryProvider } from '@ethosagent/memory-markdown';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import type {
  CompletionOptions,
  LLMProvider,
  Logger,
  MemoryContext,
  Session,
  SessionStore,
} from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import { MemoryCaptureRunner, type MemoryCaptureRunnerOptions } from '../runner';
import type { CaptureFact, CaptureJob } from '../types';

const DATA = '/root/.ethos';
const LONG =
  'Ravi now owns billing-svc and I also prefer terse answers, please remember both of those things.';
const TRIPLE = '{"subject":"Ravi","relation":"owns","object":"billing-svc"}';
const GRAPH_LINE = `MEMORY|0.8|Ravi owns billing-svc.|${TRIPLE}`;
const PREF_LINE = 'USER|0.7|Prefers terse answers.';

const LOGGER: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => LOGGER,
};

function harness(
  response: string,
  over: Partial<MemoryCaptureRunnerOptions> = {},
  sessionMeta: Record<string, unknown> = {},
) {
  const storage = new InMemoryStorage();
  const provider = new MarkdownFileMemoryProvider({ dir: DATA, storage });
  const history = new HistoryStore({ dataDir: DATA, storage });
  const prompts: Array<string | undefined> = [];
  const llm: LLMProvider = {
    name: 'fake',
    model: 'fake-model',
    maxContextTokens: 100_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(_m, _t, opts: CompletionOptions) {
      prompts.push(opts.system);
      yield { type: 'text_delta', text: response };
    },
    async countTokens() {
      return 0;
    },
  };
  const session = {
    getSession: async (id: string) =>
      ({ id, key: 'cli:ethos', metadata: sessionMeta }) as unknown as Session,
  } as unknown as SessionStore;
  const runner = new MemoryCaptureRunner({
    provider,
    history,
    session,
    llm,
    sanitize: (s) => s,
    logger: LOGGER,
    nightlyConfigured: false,
    workingDir: DATA,
    ...over,
  });
  const ctx: MemoryContext = {
    scopeId: 'personality:muse',
    sessionId: 's1',
    sessionKey: 'cli:ethos',
    platform: 'cli',
    workingDir: DATA,
  };
  return { runner, provider, history, prompts, ctx };
}

const JOB: CaptureJob = {
  sessionId: 's1',
  personalityId: 'muse',
  text: 'Noted.',
  initialPrompt: LONG,
  isDryRun: false,
};

async function run(h: ReturnType<typeof harness>): Promise<void> {
  h.runner.enqueue(JOB);
  await h.runner.whenIdle();
}

describe('routeFact', () => {
  it("no routeFact → today's behaviour", async () => {
    const h = harness(`${GRAPH_LINE}\n${PREF_LINE}`);
    await run(h);
    // The prompt carries no triple instruction, and the write calls are the old ones.
    expect(h.prompts[0]).not.toContain('"subject"');
    expect((await h.provider.read('MEMORY.md', h.ctx))?.content).toMatchInlineSnapshot(`
      "- Ravi owns billing-svc.
      "
    `);
    expect((await h.provider.read('USER.md', h.ctx))?.content).toMatchInlineSnapshot(`
      "- Prefers terse answers.
      "
    `);
    const { entries } = await h.history.read('personality:muse');
    expect(entries.map((e) => [e.key, e.actions, e.source])).toMatchInlineSnapshot(`
      [
        [
          "MEMORY.md",
          [
            "add",
          ],
          "capture",
        ],
        [
          "USER.md",
          [
            "add",
          ],
          "capture",
        ],
      ]
    `);
  });

  it('graph fact goes to a proposal, not to memory', async () => {
    const seen: Array<{ fact: CaptureFact; job: CaptureJob }> = [];
    const routeFact = vi.fn(async (fact: CaptureFact, job: CaptureJob) => {
      seen.push({ fact, job });
      return fact.triple ? ('graph' as const) : ('memory' as const);
    });
    const h = harness(`${GRAPH_LINE}\n${PREF_LINE}`, { routeFact });
    await run(h);
    expect(h.prompts[0]).toContain('"subject"');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.fact.triple).toEqual({
      subject: 'Ravi',
      relation: 'owns',
      object: 'billing-svc',
    });
    expect(seen[0]?.fact.text).toBe('Ravi owns billing-svc.');
    expect(seen[0]?.job.sessionId).toBe('s1');
    expect((await h.provider.read('MEMORY.md', h.ctx))?.content ?? '').not.toContain('Ravi');
    expect((await h.provider.read('USER.md', h.ctx))?.content).toContain('terse');
  });

  it('preference stays in memory', async () => {
    const routeFact = vi.fn(async () => 'memory' as const);
    const h = harness(PREF_LINE, { routeFact });
    await run(h);
    // A fact with no triple is never offered to the router at all.
    expect(routeFact).not.toHaveBeenCalled();
    expect((await h.provider.read('USER.md', h.ctx))?.content).toContain('terse');
  });

  it('a router that throws or answers both_never keeps the fact in memory', async () => {
    const h = harness(GRAPH_LINE, {
      routeFact: async () => {
        throw new Error('boom');
      },
    });
    await run(h);
    expect((await h.provider.read('MEMORY.md', h.ctx))?.content).toContain('Ravi owns');

    const h2 = harness(GRAPH_LINE, { routeFact: async () => 'both_never' as const });
    await run(h2);
    expect((await h2.provider.read('MEMORY.md', h2.ctx))?.content).toContain('Ravi owns');
  });

  it('R10 shared turn: nothing extracted', async () => {
    const routeFact = vi.fn(async () => 'graph' as const);
    const h = harness(GRAPH_LINE, { routeFact }, { roomAudience: 'shared' });
    await run(h);
    // evaluateEligibility refuses 'shared-audience' before the LLM and before the router.
    expect(h.prompts).toHaveLength(0);
    expect(routeFact).not.toHaveBeenCalled();
    expect((await h.provider.read('MEMORY.md', h.ctx))?.content ?? '').toBe('');
  });
});
