// Pure-builder tests for the initiative digest and brief Block Kit blocks.

import { type DigestBrief, type InitiativeDigest, parseInitiativeAction } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { briefBlocks, digestBlocks } from '../blocks/initiative';

const brief: DigestBrief = {
  explorationId: 'EXP-3',
  initiativeId: 'grow',
  question: 'Is pricing <@U1> the blocker?',
  found: [{ id: 'F-1', claim: 'Free users churn at 40%' }],
  stillUnknown: ['churn by plan'],
  options: ['Raise the free tier'],
  effort: 'about 2 days',
  risk: 'support load',
  recommendation: 'Raise the free tier',
  recommendedOption: 'A',
  partial: false,
  digDeeperUsd: 1.5,
};

const digest: InitiativeDigest = {
  personalityId: 'pm',
  generatedAt: '2026-11-28T08:00:00.000Z',
  since: '2026-11-27T08:00:00.000Z',
  ownWork: {
    windows: 2,
    spentUsd: 0.4,
    explorations: [{ id: 'EXP-1', question: 'q1', auto: true, windows: 2, spentUsd: 0.4 }],
  },
  needsYes: [{ explorationId: 'EXP-2', question: 'q2', estimateUsd: 0.5 }],
  agentInitiatives: [{ id: 'side', parentId: 'grow' }],
  briefs: [brief],
  questions: [{ id: 'Q-1', initiativeId: 'grow', text: 'Which market?' }],
  suggestions: [{ draftId: 'D-1', parentId: 'grow', why: 'a pricing watch' }],
};

type Btn = { action_id: string; value: string; text: { text: string } };
const buttons = (blocks: ReturnType<typeof digestBlocks>): Btn[] =>
  blocks.flatMap((b) => (b.type === 'actions' ? (b.elements as Btn[]) : []));

describe('initiative blocks', () => {
  it('brief shows finding ids and the four brief buttons', () => {
    const blocks = briefBlocks(brief);
    expect(JSON.stringify(blocks)).toContain('`F-1`');
    expect(buttons(blocks).map((b) => b.text.text)).toEqual([
      'Adopt A',
      'Dig deeper ($1.50)',
      'Park',
      'Copy as Markdown',
    ]);
  });

  it('digest has the Gate 1 and agent-initiative buttons', () => {
    const labels = buttons(digestBlocks(digest)).map((b) => b.text.text);
    expect(labels).toEqual([
      'Approve',
      'Edit scope',
      'Snooze 1w',
      'Never',
      'Keep',
      'Make it mine',
      'Stop',
      'Adopt A',
      'Dig deeper ($1.50)',
      'Park',
      'Copy as Markdown',
    ]);
  });

  it('every button carries only a compact action id for a ledger id', () => {
    for (const b of buttons(digestBlocks(digest))) {
      expect(b.value).toBe(b.action_id);
      expect(parseInitiativeAction(b.value)).not.toBeNull();
    }
  });

  it('escapes model-written text so it cannot inject a mention', () => {
    const text = JSON.stringify(briefBlocks(brief));
    expect(text).not.toContain('<@U1>');
    expect(text).toContain('&lt;@U1&gt;');
  });

  it('leaves out sections with nothing in them', () => {
    const quiet = digestBlocks({ ...digest, needsYes: [], agentInitiatives: [], briefs: [] });
    expect(buttons(quiet)).toEqual([]);
  });
});

describe('escaping and the section cap', () => {
  const amps = '&'.repeat(400);
  const heavy: InitiativeDigest = {
    ...digest,
    ownWork: {
      windows: 8,
      spentUsd: 1,
      explorations: Array.from({ length: 8 }, (_, i) => ({
        id: `EXP-${i}`,
        question: amps,
        auto: true,
        windows: 1,
        spentUsd: 0.1,
      })),
    },
    questions: Array.from({ length: 8 }, (_, i) => ({
      id: `Q-${i}`,
      initiativeId: 'grow',
      text: amps,
    })),
    suggestions: Array.from({ length: 8 }, (_, i) => ({
      draftId: `D-${i}`,
      parentId: 'grow',
      why: amps,
    })),
  };

  it('keeps every section at or under 3000 characters after escaping, with no half entity', () => {
    const texts = digestBlocks(heavy)
      .filter((b) => b.type === 'section')
      .map((b) => (b.text as { text: string }).text);
    expect(texts.length).toBeGreaterThan(3);
    for (const t of texts) {
      expect(t.length).toBeLessThanOrEqual(3000);
      // every '&' that survives starts a whole entity
      expect(t.replace(/&(amp|lt|gt);/g, '')).not.toContain('&');
    }
  });

  it('cuts a brief section after escaping too', () => {
    const t =
      (
        briefBlocks({ ...brief, question: amps, recommendation: amps })[0]?.text as
          | { text: string }
          | undefined
      )?.text ?? '';
    expect(t.length).toBeGreaterThan(0);
    expect(t.length).toBeLessThanOrEqual(3000);
    expect(t.replace(/&(amp|lt|gt);/g, '')).not.toContain('&');
  });
});
