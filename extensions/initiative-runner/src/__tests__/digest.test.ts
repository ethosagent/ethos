import type {
  BriefRow,
  DraftRow,
  ExplorationRow,
  FindingRow,
  InitiativeRow,
  QuestionRow,
  WindowRow,
} from '@ethosagent/types';
import { digestIsEmpty } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import {
  composeDigest,
  type DigestSource,
  renderBriefMarkdown,
  renderDigestMarkdown,
} from '../digest';

const NOW = new Date('2026-11-28T08:00:00.000Z');
const SINCE = new Date('2026-11-27T08:00:00.000Z');

const init = (id: string, state: InitiativeRow['state'], origin: 'human' | 'agent' = 'human') =>
  ({
    id,
    personalityId: 'pm',
    origin,
    parentId: origin === 'agent' ? 'grow' : null,
    state,
    configPath: '',
    configHash: '',
    version: 1,
  }) satisfies InitiativeRow;

const exp = (id: string, state: ExplorationRow['state'], q = `question ${id}`) =>
  ({
    id,
    initiativeId: 'grow',
    ideaId: null,
    question: q,
    state,
    budgetUsd: 1,
    spentUsd: 0.2,
    deadline: '2026-12-01T00:00:00.000Z',
    estimateUsd: 0.5,
  }) satisfies ExplorationRow;

const win = (explorationId: string | null, spentUsd: number, started: string): WindowRow => ({
  id: `W-${started}`,
  initiativeId: 'grow',
  explorationId,
  kind: 'window',
  started,
  ended: started,
  spentUsd,
  toolsUsed: [],
  reads: [],
  checkpoint: null,
  endReason: 'done',
});

const BODY = [
  '## Options',
  '- Raise the free tier',
  '- Drop annual pricing',
  '',
  '## Still unknown',
  '- churn by plan',
  '',
  '## Cost',
  'about 2 days',
  '',
  '## Risk',
  'support load',
  '',
  '## Recommendation',
  'Raise the free tier',
].join('\n');

function source(
  over: Partial<{ questions: QuestionRow[]; drafts: DraftRow[] }> = {},
): DigestSource {
  const explorations = [
    exp('EXP-1', 'exploring'),
    exp('EXP-2', 'proposed'),
    exp('EXP-3', 'briefed'),
    exp('EXP-4', 'parked'),
    exp('EXP-5', 'rejected'),
  ];
  const findings: FindingRow[] = [
    {
      id: 'F-1',
      explorationId: 'EXP-3',
      claim: 'Free users churn at 40%',
      sourceRef: 's',
      confidence: 0.8,
      createdAt: '',
    },
    {
      id: 'F-2',
      explorationId: 'EXP-1',
      claim: 'other',
      sourceRef: 's',
      confidence: 0.5,
      createdAt: '',
    },
  ];
  const briefs: BriefRow[] = [
    {
      id: 'B-1',
      explorationId: 'EXP-3',
      version: 1,
      bodyMd: 'old',
      recommendedOption: null,
      partial: false,
    },
    {
      id: 'B-2',
      explorationId: 'EXP-3',
      version: 2,
      bodyMd: BODY,
      recommendedOption: 'A',
      partial: false,
    },
  ];
  const rows = [init('grow', 'active'), init('side', 'self_started', 'agent')];
  return {
    store: {
      list: () => rows,
      get: (id) =>
        id === 'grow'
          ? { initiative: rows[0] as InitiativeRow, explorations, briefs, findings }
          : { initiative: rows[1] as InitiativeRow, explorations: [], briefs: [], findings: [] },
      drafts: () => over.drafts ?? [],
    },
    windows: (id) =>
      id === 'grow'
        ? [
            win('EXP-1', 0.3, '2026-11-27T12:00:00.000Z'),
            win('EXP-1', 0.4, '2026-11-20T12:00:00.000Z'),
          ]
        : [],
    questions: (id) =>
      id === 'grow'
        ? (over.questions ?? [
            {
              id: 'Q-1',
              initiativeId: 'grow',
              explorationId: null,
              text: 'Which market?',
              answer: null,
              createdAt: '',
              answeredAt: null,
            },
            {
              id: 'Q-2',
              initiativeId: 'grow',
              explorationId: null,
              text: 'answered one',
              answer: 'EU',
              createdAt: '',
              answeredAt: '',
            },
          ])
        : [],
    decisionsSince: () => [],
  };
}

const compose = (src = source(), selfStart = false) =>
  composeDigest(src, {
    personalityId: 'pm',
    now: NOW,
    since: SINCE,
    selfStart,
    usdPerExploration: new Map([['grow', 1.5]]),
  });

describe('digest', () => {
  it('digest asks only what needs the owner', () => {
    const d = compose();
    expect(d.needsYes.map((p) => p.explorationId)).toEqual(['EXP-2']);
    expect(d.briefs.map((b) => b.explorationId)).toEqual(['EXP-3']);
    expect(d.agentInitiatives.map((i) => i.id)).toEqual(['side']);
    // exploring, parked and rejected explorations ask for nothing.
    const asked = [
      ...d.needsYes.map((p) => p.explorationId),
      ...d.briefs.map((b) => b.explorationId),
    ];
    expect(asked).not.toContain('EXP-1');
    expect(asked).not.toContain('EXP-4');
    expect(asked).not.toContain('EXP-5');
    // what it did on its own counts only windows since the cut-off.
    expect(d.ownWork.windows).toBe(1);
    expect(d.ownWork.spentUsd).toBeCloseTo(0.3);
    expect(d.ownWork.explorations).toEqual([
      { id: 'EXP-1', question: 'question EXP-1', auto: true, windows: 1, spentUsd: 0.3 },
    ]);
  });

  it('reads decisions from a 7-day window before since, not the epoch', () => {
    const seen: string[] = [];
    compose({
      ...source(),
      decisionsSince: (_p, since) => {
        seen.push(since);
        return [];
      },
    });
    expect(seen).toEqual([new Date(SINCE.getTime() - 7 * 86_400_000).toISOString()]);
  });

  it('includes unanswered questions and agent suggestions only while self-start is off', () => {
    const draft: DraftRow = {
      id: 'D-1',
      parentId: 'grow',
      draftYaml: '',
      why: 'a pricing watch',
      status: 'pending',
      refusal: null,
      createdAt: '',
    };
    const d = compose(source({ drafts: [draft] }));
    expect(d.questions).toEqual([{ id: 'Q-1', initiativeId: 'grow', text: 'Which market?' }]);
    expect(d.suggestions).toEqual([{ draftId: 'D-1', parentId: 'grow', why: 'a pricing watch' }]);
    expect(compose(source({ drafts: [draft] }), true).suggestions).toEqual([]);
  });

  it('brief carries finding ids, options, effort, risk and the latest version', () => {
    const [brief] = compose().briefs;
    expect(brief?.found).toEqual([{ id: 'F-1', claim: 'Free users churn at 40%' }]);
    expect(brief?.options).toEqual(['Raise the free tier', 'Drop annual pricing']);
    expect(brief?.stillUnknown).toEqual(['churn by plan']);
    expect(brief?.effort).toBe('about 2 days');
    expect(brief?.risk).toBe('support load');
    expect(brief?.recommendedOption).toBe('A');
    expect(brief?.digDeeperUsd).toBe(1.5);
  });

  it('markdown brief includes finding ids', () => {
    const md = renderBriefMarkdown({
      question: 'Is pricing the blocker?',
      bodyMd: BODY,
      recommendedOption: 'A',
      findings: [{ id: 'F-1', claim: 'Free users churn at 40%' }],
    });
    expect(md).toContain('# Is pricing the blocker?');
    expect(md).toContain('- F-1: Free users churn at 40%');
    expect(md).toContain('Recommended option: A');
    const digest = renderDigestMarkdown(compose());
    expect(digest).toContain('- F-1: Free users churn at 40%');
    expect(digest).toContain('Which market?');
  });

  it('an empty ledger yields an empty digest', () => {
    const empty: DigestSource = {
      store: { list: () => [], get: () => null, drafts: () => [] },
      windows: () => [],
      questions: () => [],
      decisionsSince: () => [],
    };
    expect(digestIsEmpty(compose(empty))).toBe(true);
    expect(digestIsEmpty(compose())).toBe(false);
  });
});
