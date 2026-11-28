// Task 5.1 stand-in for the manual dogfood: a product-manager-like personality (read tools in
// its toolset) with one initiative, 'self-serve-activation', surveyed end to end through the
// real wiring factory (`createInitiativeRunnerFor`), the real SQLite ledger and the real
// read-only registry. Only the LLM is scripted; no network, no real model call.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DefaultPersonalityRegistry } from '@ethosagent/core';
import { InitiativeConfigService } from '@ethosagent/initiative-runner';
import { MarkdownFileMemoryProvider } from '@ethosagent/memory-markdown';
import { SQLiteSessionStore } from '@ethosagent/session-sqlite';
import { FsStorage } from '@ethosagent/storage-fs';
import type { CompletionChunk, LLMProvider } from '@ethosagent/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestSafety } from '../../../core/src/__tests__/helpers/test-safety';
import { createInitiativeRunnerFor, createLazyInitiativeStore } from '../initiatives';

const INITIATIVE_ID = 'self-serve-activation';

function scriptedLLM(responses: Array<Array<{ name: string; input: Record<string, unknown> }>>) {
  let n = 0;
  const llm: LLMProvider = {
    name: 'scripted',
    model: 'mock-model',
    maxContextTokens: 200_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(): AsyncIterable<CompletionChunk> {
      const calls = responses[n++] ?? [];
      yield {
        type: 'usage',
        usage: {
          inputTokens: 100,
          outputTokens: 50,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          estimatedCostUsd: 0.12,
        },
      };
      if (calls.length === 0) {
        yield { type: 'text_delta', text: 'Proposed three explorations.' };
        yield { type: 'done', finishReason: 'end_turn' };
        return;
      }
      for (const [i, c] of calls.entries()) {
        const id = `call-${n}-${i}`;
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
  return llm;
}

describe('initiative survey through the wiring factory (manual-run stand-in)', () => {
  let home: string;
  let dataDir: string;
  let repo: string;
  const closers: Array<{ close(): void }> = [];

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'ethos-initiative-survey-'));
    dataDir = join(home, '.ethos');
    repo = join(home, 'repo');
    mkdirSync(join(dataDir, 'personalities', 'product-manager'), { recursive: true });
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, 'README.md'), '# app\nOnboarding checklist lives in onboarding.ts\n');
    writeFileSync(
      join(dataDir, 'constitution.yaml'),
      `initiatives:\n  readableRoots:\n    - ${repo}\n`,
    );
  });

  afterAll(() => {
    for (const c of closers) c.close();
    rmSync(home, { recursive: true, force: true });
  });

  it('survey reports tools, reads, proposals and cost for a product-manager initiative', async () => {
    const storage = new FsStorage();
    const ledger = createLazyInitiativeStore({ storage, dataDir });
    closers.push(ledger);
    const session = new SQLiteSessionStore(join(dataDir, 'sessions.db'));
    closers.push(session as unknown as { close(): void });
    const memory = new MarkdownFileMemoryProvider({ dir: dataDir, storage });

    const personalities = new DefaultPersonalityRegistry();
    personalities.define({
      id: 'product-manager',
      name: 'product-manager',
      toolset: ['read_file', 'search_files', 'web_search', 'memory_read', 'session_search'],
    });

    const config = new InitiativeConfigService({
      storage,
      dataDir,
      store: ledger.store,
      constitution: async () => ({ initiatives: { readableRoots: [repo] } }),
      settings: async () => ({
        enabled: true,
        selfStart: false,
        dailyBudgetUsd: 0,
        standingGuidance: [],
      }),
      toolset: () => personalities.get('product-manager')?.toolset ?? [],
      schedule: () => {},
    });
    const saved = await config.save({
      personalityId: 'product-manager',
      op: 'create',
      sessionId: 'chat-1',
      confirmedBy: 'owner_chat',
      draft: {
        id: INITIATIVE_ID,
        version: 1,
        origin: 'human',
        created_in: 'chat',
        state: 'active',
        title: 'Self-serve activation',
        outcome: 'More trial users reach their first project',
        sources: [{ repo }, 'web'],
        exclude: [],
        guidance: [{ text: 'prefer funnel data over anecdotes' }],
        autonomy: { mode: 'ask' },
        budget: { usd_per_day: 3, usd_per_exploration: 1, max_open_explorations: 3 },
        timeline: {
          explore_windows: ['every 6h'],
          window_minutes: 20,
          default_days: 7,
          review_on: '2026-12-20',
        },
        delivery: { owner_channel: 'telegram:1', digest_time: '09:00' },
      },
    });
    expect(saved).toMatchObject({ ok: true });

    const seed = ledger.store.addIdea({
      initiativeId: INITIATIVE_ID,
      origin: 'human',
      text: 'a first-project checklist',
      sourceRef: null,
    });

    const llm = scriptedLLM([
      [
        { name: 'read_file', input: { path: join(repo, 'README.md') } },
        {
          name: 'initiative_propose',
          input: {
            kind: 'exploration',
            idea_id: seed.id,
            question: 'Does the checklist raise first-project rate?',
            estimate_usd: 0.4,
            days: 3,
          },
        },
        {
          name: 'initiative_propose',
          input: { question: 'Where do trial users stall?', estimate_usd: 0.3, days: 2 },
        },
        {
          name: 'initiative_propose',
          input: { question: 'Which invite step is slowest?', estimate_usd: 0.2, days: 2 },
        },
      ],
      [],
    ]);

    const runner = createInitiativeRunnerFor({
      storage,
      dataDir,
      ledger,
      personalities,
      llm,
      safety: createTestSafety(),
      config: {},
      toolsConfig: () => undefined,
      memory,
      session,
      clock: () => new Date('2026-11-28T10:00:00Z'),
    });

    const report = await runner.runSurvey(INITIATIVE_ID);

    expect(report.endReason).toBe('done');
    expect(report.toolsUsed).toEqual(['initiative_propose', 'read_file']);
    expect(report.reads).toEqual([`read_file: ${join(repo, 'README.md')}`]);
    expect(report.proposals).toHaveLength(3);
    expect(report.proposals.map((p) => p.state)).toEqual(['proposed', 'proposed', 'proposed']);
    expect(report.proposals.find((p) => p.ideaId === seed.id)?.question).toContain('checklist');
    expect(report.spentUsd).toBeCloseTo(0.24, 5);

    // The ledger holds the window with the same numbers, charged to the day.
    expect(ledger.store.budget(INITIATIVE_ID, '2026-11-28').spentUsd).toBeCloseTo(0.24, 5);
    // The cap is the store's, bound by the run loader to the clamped usd_per_day.
    expect(ledger.store.budget(INITIATIVE_ID, '2026-11-28').capUsd).toBe(3);
    expect(ledger.store.explorations(INITIATIVE_ID)).toHaveLength(3);
  }, 30_000);
});
