import { type DigestBrief, type InitiativeDigest, parseInitiativeAction } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { briefCard, digestCard } from '../initiative-card';

const brief: DigestBrief = {
  explorationId: 'EXP-0003',
  initiativeId: 'grow',
  question: 'Is pricing the blocker?',
  found: [{ id: 'F-0001', claim: 'Free users churn at 40%' }],
  stillUnknown: [],
  options: ['Raise the free tier'],
  effort: 'about 2 days',
  risk: 'support load',
  recommendation: 'Raise the free tier',
  recommendedOption: 'A',
  partial: false,
  digDeeperUsd: 1.5,
};

const digest = (over: Partial<InitiativeDigest> = {}): InitiativeDigest => ({
  personalityId: 'pm',
  generatedAt: '2026-11-28T08:00:00.000Z',
  since: '2026-11-27T08:00:00.000Z',
  ownWork: { windows: 0, spentUsd: 0, explorations: [] },
  needsYes: [{ explorationId: 'EXP-0002', question: 'q2', estimateUsd: 0.5 }],
  agentInitiatives: [{ id: 'side', parentId: 'grow' }],
  briefs: [brief],
  questions: [],
  suggestions: [],
  ...over,
});

const bytes = (s: string) => Buffer.byteLength(s, 'utf8');

describe('initiative card', () => {
  it('callback_data is at most 64 bytes and parses back', () => {
    const card = digestCard(digest());
    const all = card.rows.flat();
    expect(all.length).toBeGreaterThan(0);
    for (const b of all) {
      expect(bytes(b.data)).toBeLessThanOrEqual(64);
      expect(parseInitiativeAction(b.data)).not.toBeNull();
    }
  });

  it('an over-long target gets no buttons, never a truncated id', () => {
    const long = 'x'.repeat(80);
    const card = digestCard(
      digest({ needsYes: [], briefs: [], agentInitiatives: [{ id: long, parentId: null }] }),
    );
    expect(card.rows).toEqual([]);
    expect(card.text).toContain(`ethos initiatives keep ${long}`);
  });

  it('brief card shows finding ids and the four brief buttons', () => {
    const card = briefCard(brief);
    expect(card.text).toContain('F-0001');
    expect(card.rows.flat().map((b) => b.label)).toEqual([
      'Adopt A',
      'Dig deeper ($1.50)',
      'Park',
      'Copy as Markdown',
    ]);
  });

  it('a brief whose id is too long for callback_data names the CLI command', () => {
    const long = { ...brief, explorationId: 'EXP-'.padEnd(70, '9') };
    const card = briefCard(long);
    expect(card.rows).toEqual([]);
    expect(card.text).toContain(`ethos initiatives adopt ${long.explorationId}`);
    expect(
      digestCard(digest({ needsYes: [], agentInitiatives: [], briefs: [long] })).text,
    ).toContain(`ethos initiatives adopt ${long.explorationId}`);
  });
});
