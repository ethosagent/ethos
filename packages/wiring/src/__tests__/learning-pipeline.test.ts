// L-T6 — the learning inbox's composition root: the one-time legacy import, the
// auto knobs read in one place, and the case builders the fork, chat and the
// nightly pass freeze through. The replay loop itself is pinned by
// `replay-isolation.test.ts`; the resolver's rules by
// `extensions/learning-inbox/src/__tests__/auto-promotion.test.ts`.

import { join } from 'node:path';
import { InMemorySessionStore } from '@ethosagent/core';
import { listCandidates, listCases } from '@ethosagent/learning-inbox';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import type { PersonalityConfig } from '@ethosagent/types';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  freezeLatestUserTurnCase,
  freezeNightlyCases,
  importLegacyLearningQueues,
  learningPolicyFor,
} from '../learning-pipeline';

const DATA = '/ethos';
const SOUL = '# Core\nI am careful.\n# Expression\nI speak plainly.\n';

let storage: InMemoryStorage;
let configs: Record<string, PersonalityConfig>;
const personalities = { get: (id: string) => configs[id] };

async function seed(path: string, content: string): Promise<void> {
  await storage.mkdir(path.slice(0, path.lastIndexOf('/')));
  await storage.write(path, content);
}

beforeEach(async () => {
  storage = new InMemoryStorage();
  configs = {
    researcher: {
      id: 'researcher',
      name: 'Researcher',
      soulFile: join(DATA, 'personalities', 'researcher', 'SOUL.md'),
      skill_evolution: { scope: 'personality' },
    },
    scout: { id: 'scout', name: 'Scout' },
  };
  await seed(join(DATA, 'personalities', 'researcher', 'SOUL.md'), SOUL);
});

describe('importLegacyLearningQueues', () => {
  it('runs, drains all four legacy queues, and is idempotent on a second run', async () => {
    const skill = '---\nname: cite\n---\n\nCite.\n';
    await seed(join(DATA, 'skills', 'pending', 'eval-skill.md'), skill);
    await seed(join(DATA, 'skills', '.pending', 'chat-skill.md'), skill);
    await seed(join(DATA, 'skills', '.pending', 'researcher', 'fork-skill.md'), skill);
    await seed(
      join(DATA, 'learning', 'pending-expression', 'researcher.json'),
      JSON.stringify({ personalityId: 'researcher', newExpression: 'New voice.', baseHash: 'x' }),
    );
    const ctx = { storage, dataDir: DATA, personalities, defaultPersonalityId: 'scout' };

    const first = await importLegacyLearningQueues(ctx);

    expect(first.alreadyImported).toBe(false);
    expect(first.sources).toEqual({
      skillsPending: 1,
      skillsDotPendingFlat: 1,
      skillsDotPendingPerPersonality: 1,
      pendingExpression: 1,
    });
    const candidates = await listCandidates(storage, DATA);
    expect(candidates).toHaveLength(4);
    // `skill_evolution.scope` resolves the destination: researcher is personality-scoped.
    const fork = candidates.find((c) => c.evidence.ref?.endsWith('fork-skill.md'));
    expect(fork?.destination).toBe(
      join(DATA, 'personalities', 'researcher', 'skills', 'fork-skill.md'),
    );
    const expression = candidates.find((c) => c.kind === 'expression');
    expect(expression).toMatchObject({
      origin: 'nightly',
      destination: join(DATA, 'personalities', 'researcher', 'SOUL.md'),
    });
    expect(await storage.list(join(DATA, 'skills', 'pending'))).toEqual([]);
    expect(await storage.list(join(DATA, 'learning', 'pending-expression'))).toEqual([]);

    const second = await importLegacyLearningQueues(ctx);
    expect(second.alreadyImported).toBe(true);
    expect(await listCandidates(storage, DATA)).toHaveLength(4);
  });
});

describe('learningPolicyFor (L-D3 — one reader for the three knobs)', () => {
  it('reads evolve-config.json autoApprove fresh on every call', async () => {
    const policy = learningPolicyFor({ storage, dataDir: DATA, personalities });
    const candidate = { personalityId: 'scout' } as Parameters<typeof policy>[0];

    expect((await policy(candidate)).knobs.globalAutoApprove).toBe(false);
    await seed(join(DATA, 'evolve-config.json'), JSON.stringify({ autoApprove: true }));
    expect((await policy(candidate)).knobs.globalAutoApprove).toBe(true);
  });

  it('carries the personality knobs and the current scope', async () => {
    configs.researcher = {
      ...configs.researcher,
      id: 'researcher',
      name: 'Researcher',
      evolution_approval_mode: 'user',
      skill_evolution: { scope: 'personality', promotion: 'auto' },
    };
    const policy = learningPolicyFor({
      storage,
      dataDir: DATA,
      personalities,
      autoApproveOverride: true,
    });
    const result = await policy({ personalityId: 'researcher' } as Parameters<typeof policy>[0]);
    expect(result).toEqual({
      knobs: { promotion: 'auto', approvalMode: 'user', globalAutoApprove: true },
      scope: 'personality',
    });
  });
});

describe('case freezing', () => {
  async function sessionWith(key: string, personalityId = 'researcher') {
    const sessions = new InMemorySessionStore();
    const s = await sessions.createSession({
      key,
      platform: 'cli',
      model: 'm',
      provider: 'p',
      personalityId,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        estimatedCostUsd: 0,
        apiCallCount: 0,
        compactionCount: 0,
      },
    });
    await sessions.appendMessage({ sessionId: s.id, role: 'user', content: 'first question' });
    await sessions.appendMessage({ sessionId: s.id, role: 'assistant', content: 'first answer' });
    await sessions.appendMessage({ sessionId: s.id, role: 'user', content: 'find sources for X' });
    return { sessions, session: s };
  }

  it('freezes the latest user turn with its context and the Core assertion', async () => {
    const { sessions, session } = await sessionWith('cli:project');
    const id = await freezeLatestUserTurnCase({ storage, dataDir: DATA, personalities }, sessions, {
      sessionId: session.id,
      sessionKey: session.key,
      personalityId: 'researcher',
    });

    expect(id).not.toBeNull();
    const [frozen] = await listCases(storage, DATA, 'researcher');
    expect(frozen).toMatchObject({
      id,
      prompt: 'find sources for X',
      context: ['first question', 'first answer'],
      source: 'session',
    });
    expect(frozen?.assertions[0]?.value).toContain('I am careful.');
  });

  it('freezes nothing for a session under an excluded key prefix (X-D7)', async () => {
    const { sessions, session } = await sessionWith('eval:researcher:p1');
    const id = await freezeLatestUserTurnCase({ storage, dataDir: DATA, personalities }, sessions, {
      sessionId: session.id,
      sessionKey: session.key,
      personalityId: 'researcher',
    });
    expect(id).toBeNull();
    expect(await listCases(storage, DATA, 'researcher')).toEqual([]);
  });

  it('the nightly freeze pass skips a missing board and freezes session turns', async () => {
    const { sessions } = await sessionWith('cli:project');
    const result = await freezeNightlyCases(
      { storage, dataDir: DATA, personalities },
      { personalityId: 'researcher', sessions, kanbanDbPath: join(DATA, 'board.db') },
    );
    expect(result.frozen).toHaveLength(2);
    expect(await storage.exists(join(DATA, 'board.db'))).toBe(false);
  });
});
