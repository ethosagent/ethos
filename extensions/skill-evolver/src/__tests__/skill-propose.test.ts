import { InMemoryStorage } from '@ethosagent/storage-fs';
import type { ToolContext } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
// Relative on purpose: `@ethosagent/learning-inbox` is not a dependency of this
// package (it is injected through `LearningSubmitPort`), but the test submits
// through the REAL store so it asserts a real candidate, not a stand-in.
import { listCandidates, readCandidate, submitCandidate } from '../../../learning-inbox/src/store';
import type { LearningSubmitPort } from '../learning-port';
import { createSkillProposeTool } from '../tools/skill-propose';

const DATA = '/ethos';

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionId: 'chat-session',
    sessionKey: 'cli:project',
    platform: 'cli',
    workingDir: '/tmp',
    agentId: 'depth:0',
    personalityId: 'me',
    currentTurn: 1,
    messageCount: 1,
    abortSignal: new AbortController().signal,
    emit: () => {},
    resultBudgetChars: 80_000,
    ...overrides,
  };
}

function port(storage: InMemoryStorage): LearningSubmitPort {
  return {
    submit: (input) => submitCandidate(storage, DATA, input),
    has: async (id) => (await readCandidate(storage, DATA, id)) !== null,
  };
}

function makeTool(
  storage: InMemoryStorage,
  opts: {
    onProposed?: (id: string) => void;
    scope?: 'personality' | 'shared';
    targetCaseIds?: string[];
  } = {},
) {
  return createSkillProposeTool({
    learning: port(storage),
    dataDir: DATA,
    origin: 'chat',
    target: (ctx) =>
      ctx.personalityId ? { personalityId: ctx.personalityId, scope: opts.scope } : null,
    targetCaseIds: async () => opts.targetCaseIds ?? [],
    now: () => 1700000000000,
    onProposed: opts.onProposed,
  });
}

describe('skill_propose targetFile validation', () => {
  it('accepts a plain skill filename and submits a rewrite of that file', async () => {
    const storage = new InMemoryStorage();
    let proposed: string | null = null;
    const tool = makeTool(storage, {
      onProposed: (id) => {
        proposed = id;
      },
    });

    const result = await tool.execute(
      { content: '# body', reason: 'because', targetFile: 'tool-usage.md' },
      makeCtx(),
    );

    expect(result.ok).toBe(true);
    const [candidate] = await listCandidates(storage, DATA);
    expect(proposed).toBe(candidate?.id);
    expect(candidate).toMatchObject({ op: 'rewrite', destination: '/ethos/skills/tool-usage.md' });
    expect(candidate?.content).toContain('target_file: tool-usage.md');
    expect(candidate?.content).toContain('name: rewrite-tool-usage-1700000000000');
  });

  it('accepts a filename without the .md extension', async () => {
    const storage = new InMemoryStorage();
    const result = await makeTool(storage).execute(
      { content: '# body', reason: 'because', targetFile: 'tool_usage-2' },
      makeCtx(),
    );
    expect(result.ok).toBe(true);
  });

  for (const targetFile of [
    'a b.md',
    'a;rm -rf ~.md',
    'a$(id).md',
    "a'.md",
    'a\nalways: true\nx.md',
    '../escape.md',
    'sub/dir.md',
    'a\\b.md',
    '.md',
  ]) {
    it(`rejects targetFile ${JSON.stringify(targetFile)}`, async () => {
      const storage = new InMemoryStorage();
      let proposed: string | null = null;
      const tool = makeTool(storage, {
        onProposed: (id) => {
          proposed = id;
        },
      });

      const result = await tool.execute({ content: '# body', reason: 'r', targetFile }, makeCtx());

      expect(result).toEqual({
        ok: false,
        error:
          'Invalid targetFile: use a plain skill filename (letters, digits, `_`, `-`, optional `.md`)',
        code: 'input_invalid',
      });
      expect(proposed).toBeNull();
      expect(await listCandidates(storage, DATA)).toEqual([]);
    });
  }

  it('still proposes a new skill when targetFile is omitted', async () => {
    const storage = new InMemoryStorage();
    const result = await makeTool(storage).execute(
      { content: '# body', reason: 'because' },
      makeCtx(),
    );
    expect(result.ok).toBe(true);
  });
});

describe('skill_propose submits to the learning inbox (L-T6, path 6: chat)', () => {
  it('submits a chat-origin candidate and writes nothing to a pending queue or live dir', async () => {
    const storage = new InMemoryStorage();
    const tool = makeTool(storage, { scope: 'personality', targetCaseIds: ['case-1'] });
    const result = await tool.execute(
      { content: '# Cite\nCite every claim.', reason: 'keeps answers honest' },
      makeCtx(),
    );

    expect(result.ok).toBe(true);
    const candidates = await listCandidates(storage, DATA);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      kind: 'skill',
      op: 'create',
      origin: 'chat',
      personalityId: 'me',
      status: 'pending_replay',
      baseHash: null,
      targetCaseIds: ['case-1'],
      evidence: { sessionIds: ['chat-session'] },
    });
    expect(candidates[0]?.destination).toMatch(/^\/ethos\/personalities\/me\/skills\/new-.*\.md$/);
    expect(await storage.exists('/ethos/skills/.pending')).toBe(false);
    expect(await storage.exists('/ethos/personalities/me/skills')).toBe(false);
  });

  it('records the live bytes a rewrite was drafted against', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir('/ethos/skills');
    await storage.write('/ethos/skills/summarise.md', 'old bytes');
    await makeTool(storage).execute(
      { content: '# body', reason: 'r', targetFile: 'summarise' },
      makeCtx(),
    );
    const [candidate] = await listCandidates(storage, DATA);
    expect(candidate?.baseHash).not.toBeNull();
  });

  it('refuses when no personality is bound to the turn', async () => {
    const storage = new InMemoryStorage();
    const result = await makeTool(storage).execute(
      { content: '# body', reason: 'r' },
      makeCtx({ personalityId: undefined }),
    );
    expect(result.ok).toBe(false);
    expect(await listCandidates(storage, DATA)).toEqual([]);
  });
});

describe('skill_propose honours skill_evolution.evolve_existing', () => {
  function toolFor(storage: InMemoryStorage, evolveExisting: boolean | undefined) {
    return createSkillProposeTool({
      learning: port(storage),
      dataDir: DATA,
      origin: 'fork',
      target: (ctx) => ({
        personalityId: ctx.personalityId ?? 'me',
        scope: undefined,
        evolveExisting,
      }),
      now: () => 1700000000000,
    });
  }

  it('false refuses a targetFile rewrite and submits nothing', async () => {
    const storage = new InMemoryStorage();
    const result = await toolFor(storage, false).execute(
      { content: '# body', reason: 'because', targetFile: 'json.md' },
      makeCtx(),
    );
    expect(result).toMatchObject({ ok: false, code: 'not_available' });
    expect(await listCandidates(storage, DATA)).toEqual([]);
  });

  it('false still accepts a new skill', async () => {
    const storage = new InMemoryStorage();
    const result = await toolFor(storage, false).execute(
      { content: '# body', reason: 'because' },
      makeCtx(),
    );
    expect(result.ok).toBe(true);
    const [candidate] = await listCandidates(storage, DATA);
    expect(candidate?.op).toBe('create');
  });

  it('absent allows a rewrite', async () => {
    const storage = new InMemoryStorage();
    const result = await toolFor(storage, undefined).execute(
      { content: '# body', reason: 'because', targetFile: 'json.md' },
      makeCtx(),
    );
    expect(result.ok).toBe(true);
    const [candidate] = await listCandidates(storage, DATA);
    expect(candidate?.op).toBe('rewrite');
  });
});
