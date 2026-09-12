// L-T2 — case capture, the excluded-key list, the pool cap, and freezing.

import { InMemoryStorage } from '@ethosagent/storage-fs';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  CASE_POOL_CAP,
  captureCases,
  caseFromEvalTask,
  caseFromKanbanTask,
  caseFromSessionTurn,
  enforceCasePoolCap,
  freezeCase,
  isExcludedSessionKey,
  LEARNING_EXCLUDED_KEY_PREFIXES,
  type LearningCase,
  listCases,
} from '../cases';
import { casePath } from '../paths';

const DATA = '/ethos';
const PID = 'researcher';
const CORE = 'I am precise and I cite.';
const AT = '2026-09-12T00:00:00.000Z';

let storage: InMemoryStorage;

beforeEach(() => {
  storage = new InMemoryStorage();
});

describe('kanban cases', () => {
  it('drops check: lines and keeps the prose as one criteria assertion', () => {
    const c = caseFromKanbanTask(
      PID,
      {
        id: 'task-7',
        title: 'Summarise the Q3 report',
        body: 'One page, with sources.',
        acceptanceCriteria: [
          'The summary names every revenue driver.',
          'check: file_exists out/q3.md',
          '- check: run pnpm test exit 0',
          'It reads like a briefing, not a list.',
        ].join('\n'),
      },
      AT,
    );

    expect(c).not.toBeNull();
    expect(c?.assertions).toEqual([
      {
        kind: 'criteria',
        value: 'The summary names every revenue driver.\nIt reads like a briefing, not a list.',
      },
    ]);
    expect(c?.prompt).toBe('Summarise the Q3 report\n\nOne page, with sources.');
    expect(c?.source).toBe('kanban');
    expect(c?.sourceRef).toBe('kanban:task-7');
  });

  it('captures nothing when the criteria are only check: lines', () => {
    expect(
      caseFromKanbanTask(
        PID,
        {
          id: 'task-8',
          title: 'Build it',
          body: '',
          acceptanceCriteria: 'check: file_exists dist/index.js',
        },
        AT,
      ),
    ).toBeNull();
  });
});

describe('eval cases', () => {
  it('keeps the authored match kind', () => {
    expect(
      caseFromEvalTask(
        PID,
        { id: 'e1', prompt: 'Capital of France?', expected: 'Paris', match: 'contains' },
        AT,
      )?.assertions,
    ).toEqual([{ kind: 'contains', value: 'Paris' }]);
    expect(
      caseFromEvalTask(PID, { id: 'e2', prompt: 'Explain', expected: 'is clear', match: 'llm' }, AT)
        ?.assertions,
    ).toEqual([{ kind: 'criteria', value: 'is clear' }]);
    expect(
      caseFromEvalTask(PID, { id: 'e3', prompt: 'Echo', expected: '^ok$', match: 'regex' }, AT)
        ?.assertions,
    ).toEqual([{ kind: 'regex', value: '^ok$' }]);
  });
});

describe('excluded session keys', () => {
  it('never captures a session under any excluded prefix', () => {
    expect(LEARNING_EXCLUDED_KEY_PREFIXES).toEqual([
      'eval:',
      'replay:',
      'improvement-fork-',
      'nightly',
      'cron:',
      'mcp:',
      'mcp-console:',
      'outbox-review:',
      'pack-check:',
    ]);

    for (const prefix of LEARNING_EXCLUDED_KEY_PREFIXES) {
      const sessionKey = `${prefix}whatever`;
      expect(isExcludedSessionKey(sessionKey)).toBe(true);
      expect(
        caseFromSessionTurn(PID, { sessionKey, messageId: `m-${prefix}`, prompt: 'hi' }, CORE, AT),
      ).toBeNull();
    }
  });

  it('captures an ordinary user turn with both criteria assertions', () => {
    const c = caseFromSessionTurn(
      PID,
      {
        sessionKey: 'cli:ethos',
        messageId: 'm1',
        prompt: 'What changed in the report?',
        context: ['one', 'two', 'three', 'four', 'five'],
      },
      CORE,
      AT,
    );
    expect(c?.assertions).toEqual([
      { kind: 'criteria', value: `stays true to this Core: ${CORE}` },
      { kind: 'criteria', value: 'directly addresses the request' },
    ]);
    // Up to four preceding messages, the four nearest the prompt.
    expect(c?.context).toEqual(['two', 'three', 'four', 'five']);
  });
});

describe('the pool', () => {
  function caseAt(n: number): LearningCase {
    return {
      id: `case${String(n).padStart(3, '0')}`,
      personalityId: PID,
      prompt: `p${n}`,
      context: [],
      assertions: [{ kind: 'criteria', value: 'good' }],
      source: 'session',
      sourceRef: `session:m${n}`,
      frozenAt: new Date(Date.parse(AT) + n * 1000).toISOString(),
    };
  }

  it('caps at 40 and evicts oldest first', async () => {
    for (let n = 0; n < 45; n += 1) await freezeCase(storage, DATA, caseAt(n));
    expect(await listCases(storage, DATA, PID)).toHaveLength(45);

    const evicted = await enforceCasePoolCap(storage, DATA, PID);

    expect(CASE_POOL_CAP).toBe(40);
    expect(evicted).toEqual([0, 1, 2, 3, 4].map((n) => caseAt(n).id));
    const left = await listCases(storage, DATA, PID);
    expect(left).toHaveLength(40);
    expect(left[0]?.id).toBe(caseAt(5).id);
    expect(left.at(-1)?.id).toBe(caseAt(44).id);
  });

  it('freezes at most ten new cases per pass', async () => {
    const result = await captureCases({
      storage,
      dataDir: DATA,
      personalityId: PID,
      core: CORE,
      sessionTurns: async () =>
        Array.from({ length: 15 }, (_, n) => ({
          sessionKey: 'cli:ethos',
          messageId: `m${n}`,
          prompt: `ask ${n}`,
        })),
      now: () => Date.parse(AT),
    });

    expect(result.frozen).toHaveLength(10);
    expect(await listCases(storage, DATA, PID)).toHaveLength(10);
  });

  it('leaves a frozen case byte-identical when it is captured again', async () => {
    const kanbanTasks = async () => [
      {
        id: 'task-7',
        title: 'Summarise the Q3 report',
        body: 'One page, with sources.',
        acceptanceCriteria: 'The summary names every revenue driver.',
      },
    ];

    const first = await captureCases({
      storage,
      dataDir: DATA,
      personalityId: PID,
      core: CORE,
      kanbanTasks,
      now: () => Date.parse(AT),
    });
    expect(first.frozen).toHaveLength(1);
    const id = first.frozen[0] ?? '';
    const bytes = await storage.read(casePath(DATA, PID, id));

    // A later night, a different clock, an edited ticket: the frozen file wins.
    const second = await captureCases({
      storage,
      dataDir: DATA,
      personalityId: PID,
      core: 'a completely different Core',
      kanbanTasks: async () => [
        { ...(await kanbanTasks())[0], body: 'Two pages now.' } as Awaited<
          ReturnType<typeof kanbanTasks>
        >[number],
      ],
      now: () => Date.parse('2026-10-01T00:00:00.000Z'),
    });

    expect(second.frozen).toEqual([]);
    expect(second.skipped).toBe(1);
    expect(await storage.read(casePath(DATA, PID, id))).toBe(bytes);
  });
});
