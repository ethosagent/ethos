import {
  LearningCandidateOriginSchema,
  LearningCandidateStatusSchema,
} from '@ethosagent/web-contracts';
import { describe, expect, it } from 'vitest';
import {
  candidateIdFromEvidenceRef,
  candidateTitle,
  DRY_RUN_CAVEAT,
  deltaDirection,
  formatDelta,
  kindLabel,
  LEARNING_GROUPS,
  learningPath,
  ORIGIN_LABELS,
  rowPill,
  scorecardCaveats,
  unifiedDiff,
  verdictPill,
  waitingLinkText,
} from '../learning';

// Pure derivations behind the Learning inbox (plan `trust-before-reach.md`
// Part 4, L-T9).

describe('LEARNING_GROUPS', () => {
  it('places every wire status in exactly one group', () => {
    for (const status of LearningCandidateStatusSchema.options) {
      const owners = LEARNING_GROUPS.filter((g) => g.statuses.includes(status));
      expect(owners, status).toHaveLength(1);
    }
  });

  it('renders the four groups in the mockup order', () => {
    expect(LEARNING_GROUPS.map((g) => g.label)).toEqual([
      'Needs review',
      'Waiting for replay',
      'Promoted',
      'Rejected & rolled back',
    ]);
  });
});

describe('chip labels', () => {
  it('names the kind the way the mockup does', () => {
    expect(kindLabel({ kind: 'skill', op: 'create' })).toBe('New skill');
    expect(kindLabel({ kind: 'skill', op: 'rewrite' })).toBe('Skill rewrite');
    expect(kindLabel({ kind: 'skill', op: 'update' })).toBe('Skill rewrite');
    expect(kindLabel({ kind: 'expression', op: 'update' })).toBe('Expression');
  });

  it('has a label for every origin, with the fork shown as Live', () => {
    for (const origin of LearningCandidateOriginSchema.options) {
      expect(ORIGIN_LABELS[origin]).toBeTruthy();
    }
    expect(ORIGIN_LABELS.fork).toBe('Live');
  });

  it('titles a skill by its frontmatter name, then its filename', () => {
    expect(
      candidateTitle({
        kind: 'skill',
        content: '---\nname: "cite-sources"\n---\nbody',
        destination: '/x/other.md',
      }),
    ).toBe('cite-sources');
    expect(
      candidateTitle({ kind: 'skill', content: 'no frontmatter', destination: '/x/rg.md' }),
    ).toBe('rg');
  });
});

describe('pills carry an icon and a word', () => {
  it('counts the cases a passing candidate held on', () => {
    const cases = [{ delta: 0.5 }, { delta: 0 }, { delta: -0.25 }, { delta: null }];
    expect(verdictPill('pass', { cases } as never).word).toBe('Pass 2/3');
    expect(verdictPill(null)).toEqual({ icon: '·', word: 'Not run', tone: 'muted' });
    expect(verdictPill('regress').icon).toBe('✗');
    expect(verdictPill('incomplete').word).toBe('Incomplete');
  });

  it('shows the status word once a candidate is closed', () => {
    expect(rowPill({ status: 'rejected', verdict: 'regress' }).word).toBe('Rejected');
    expect(rowPill({ status: 'rolled_back', verdict: 'pass' }).word).toBe('Rolled back');
    expect(rowPill({ status: 'pending_review', verdict: 'pass' }).word).toBe('Pass');
  });
});

describe('Δ', () => {
  it('signs and directs each difference', () => {
    expect([formatDelta(0.5), deltaDirection(0.5)]).toEqual(['+0.50', 'up']);
    expect([formatDelta(-0.25), deltaDirection(-0.25)]).toEqual(['−0.25', 'down']);
    expect([formatDelta(0), deltaDirection(0)]).toEqual(['0.00', 'flat']);
    expect([formatDelta(0.001), deltaDirection(0.001)]).toEqual(['0.00', 'flat']);
    expect([formatDelta(null), deltaDirection(null)]).toEqual(['—', 'none']);
  });
});

describe('unifiedDiff', () => {
  it('keeps shared lines and marks the change', () => {
    expect(
      unifiedDiff(
        '## Citing\nQuote the source.\nPrefer primary.\n',
        '## Citing\nName the file.\nPrefer primary.\n',
      ),
    ).toEqual([
      { kind: 'same', text: '## Citing' },
      { kind: 'del', text: 'Quote the source.' },
      { kind: 'add', text: 'Name the file.' },
      { kind: 'same', text: 'Prefer primary.' },
    ]);
  });

  it('makes every line an add when nothing is live', () => {
    expect(unifiedDiff(null, 'a\nb')).toEqual([
      { kind: 'add', text: 'a' },
      { kind: 'add', text: 'b' },
    ]);
  });
});

describe('scorecardCaveats', () => {
  it('passes the server limitations through when they carry the dry-run caveat', () => {
    expect(scorecardCaveats({ limitations: ['dry-run: tools stubbed — x', 'grader'] })).toEqual([
      'dry-run: tools stubbed — x',
      'grader',
    ]);
  });

  it('still says tools were stubbed when a report arrives without it', () => {
    expect(scorecardCaveats({ limitations: [] })).toEqual([DRY_RUN_CAVEAT]);
  });
});

describe('links into Learning', () => {
  it('reads the candidate id promote() writes into a Learning Log entry', () => {
    expect(candidateIdFromEvidenceRef('learning:cand-7')).toBe('cand-7');
    expect(candidateIdFromEvidenceRef('web:2026-09-12T00:00:00Z')).toBeNull();
  });

  it('builds filtered paths', () => {
    expect(learningPath({})).toBe('/learning');
    expect(learningPath({ personality: 'researcher' })).toBe('/learning?personality=researcher');
    expect(learningPath({ kind: 'skill' })).toBe('/learning?kind=skill');
    expect(learningPath({ candidate: 'c1' })).toBe('/learning?candidate=c1');
  });

  it('counts what is waiting', () => {
    expect(waitingLinkText(3)).toBe('3 changes waiting in Learning →');
    expect(waitingLinkText(1)).toBe('1 change waiting in Learning →');
    expect(waitingLinkText(0, 'skill change')).toBe('No skill changes waiting in Learning →');
    expect(waitingLinkText(undefined)).toBe('Open Learning →');
  });
});
