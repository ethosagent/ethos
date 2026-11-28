import { describe, expect, it } from 'vitest';
import { decideAutonomy, settleWindow } from '../autonomy';
import { digDeeper } from '../dig-deeper';
import { fakeLedger, harness, makeFile, NOW, scriptedLLM } from './helpers/fake-ledger';

const propose = (question: string, estimate_usd: number) => ({
  name: 'initiative_propose',
  input: { question, estimate_usd, days: 3 },
});

function setup(file = makeFile()) {
  const ledger = fakeLedger();
  ledger.seedInitiative(file);
  return { ledger, file };
}

describe('Gate 1 autonomy', () => {
  it('free_under asks above the limit', async () => {
    const file = makeFile({ autonomy: { mode: 'free_under', ask_above_usd: 1 } });
    const { ledger } = setup(file);
    const { llm } = scriptedLLM([[propose('expensive', 1.4), propose('cheap', 0.9)], []], 0.05);
    const report = await harness({ ledger, llm, files: { [file.id]: file } }).runSurvey(file.id);

    const [expensive, cheap] = report.proposals;
    expect(expensive?.state).toBe('proposed');
    expect(cheap?.state).toBe('exploring');
    expect(report.waiting.map((w) => w.explorationId)).toEqual([expensive?.id]);
    expect(report.started.map((s) => s.explorationId)).toEqual([cheap?.id]);
    expect(report.waiting[0]?.reason).toContain('above $1.00');
    // An automatic start is a transition, not a decision row (see autonomy.ts).
    expect(ledger.decisions).toEqual([]);
  });

  it('ask waits for every proposal and free starts them', async () => {
    for (const [mode, state] of [
      ['ask', 'proposed'],
      ['free', 'exploring'],
    ] as const) {
      const file = makeFile({ autonomy: { mode } });
      const { ledger } = setup(file);
      const { llm } = scriptedLLM([[propose('a', 0.2), propose('b', 5)], []], 0.05);
      const report = await harness({ ledger, llm, files: { [file.id]: file } }).runSurvey(file.id);
      expect(report.proposals.map((p) => p.state)).toEqual([state, state]);
    }
  });

  it('an estimate equal to the limit starts, an unknown estimate waits', () => {
    const auto = { mode: 'free_under', ask_above_usd: 1 } as const;
    expect(decideAutonomy(auto, 1).start).toBe(true);
    expect(decideAutonomy(auto, null).start).toBe(false);
  });

  it('a start needs a free slot under max_open_explorations', async () => {
    const file = makeFile({
      autonomy: { mode: 'free' },
      budget: { usd_per_day: 3, usd_per_exploration: 1, max_open_explorations: 1 },
    });
    const { ledger } = setup(file);
    const { llm } = scriptedLLM([[propose('a', 0.2), propose('b', 0.2)], []], 0.05);
    const report = await harness({ ledger, llm, files: { [file.id]: file } }).runSurvey(file.id);
    expect(report.proposals.map((p) => p.state)).toEqual(['exploring', 'proposed']);
    expect(report.waiting[0]?.reason).toContain('max_open_explorations');
  });

  it('a paused initiative does not run', async () => {
    const file = makeFile();
    const ledger = fakeLedger();
    ledger.seedInitiative(file, 'product-manager', { state: 'paused' });
    const { llm } = scriptedLLM([[]]);
    await expect(
      harness({ ledger, llm, files: { [file.id]: file } }).runSurvey(file.id),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});

describe('stalls and partial briefs', () => {
  it('stalled exploration hands in a partial brief', async () => {
    const { ledger, file } = setup();
    const exp = ledger.seedExploration({
      id: 'EXP-1',
      initiativeId: file.id,
      budgetUsd: 0.5,
    });
    ledger.addFinding({
      explorationId: exp.id,
      claim: 'drop at step 2',
      sourceRef: 'u',
      confidence: 0.6,
    });
    const runner = (turns: Parameters<typeof scriptedLLM>[0]) =>
      harness({ ledger, llm: scriptedLLM(turns, 0.3).llm, files: { [file.id]: file } });

    // Window 1 spends past the exploration's budget without a brief: it stalls, never silently.
    const first = await runner([
      [
        {
          name: 'initiative_note',
          input: { exploration_id: exp.id, claim: 'c', source_ref: 's', confidence: 0.5 },
        },
      ],
      [
        {
          name: 'initiative_note',
          input: { exploration_id: exp.id, claim: 'd', source_ref: 's', confidence: 0.5 },
        },
      ],
      [],
    ]).runWindow(file.id, exp.id);
    expect(first.endReason).toBe('exploration');
    expect(first.outcome).toBe('stalled');
    expect(ledger.getExploration(exp.id)?.state).toBe('stalled');

    // Window 2 is a brief window: it must call initiative_brief with partial: true.
    const scripted = scriptedLLM(
      [
        [
          {
            name: 'initiative_brief',
            input: { exploration_id: exp.id, partial: true, recommendation: 'dig deeper' },
          },
        ],
        [],
      ],
      0.05,
    );
    const second = await harness({
      ledger,
      llm: scripted.llm,
      files: { [file.id]: file },
    }).runWindow(file.id, exp.id);
    expect(second.kind).toBe('brief');
    expect(scripted.prompts[0]).toContain('partial: true');
    expect(ledger.briefs).toHaveLength(1);
    expect(ledger.briefs[0]?.partial).toBe(true);
    expect(second.outcome).toBe('briefed');
    expect(ledger.getExploration(exp.id)?.state).toBe('briefed');
    expect(ledger.windows.map((w) => w.kind)).toEqual(['window', 'brief']);
  });

  it('days used stalls an exploring exploration before its window', async () => {
    const { ledger, file } = setup();
    const exp = ledger.seedExploration({
      id: 'EXP-1',
      initiativeId: file.id,
      deadline: '2026-11-27T00:00:00.000Z',
    });
    const scripted = scriptedLLM(
      [
        [
          {
            name: 'initiative_brief',
            input: { exploration_id: exp.id, partial: true, recommendation: 'r' },
          },
        ],
        [],
      ],
      0.05,
    );
    const report = await harness({
      ledger,
      llm: scripted.llm,
      files: { [file.id]: file },
    }).runWindow(file.id, exp.id);
    expect(report.kind).toBe('brief');
    expect(ledger.transitions[0]).toMatchObject({ id: exp.id, to: 'stalled' });
    expect(ledger.getExploration(exp.id)?.state).toBe('briefed');
  });

  it('dig deeper reopens with a new budget', async () => {
    const { ledger, file } = setup();
    const exp = ledger.seedExploration({
      id: 'EXP-1',
      initiativeId: file.id,
      state: 'briefed',
      budgetUsd: 0.5,
      spentUsd: 0.5,
    });
    ledger.submitBrief({
      explorationId: exp.id,
      bodyMd: 'b',
      recommendedOption: 'r',
      partial: true,
    });
    // The owner's decision path: the decision row, then the fresh budget and deadline.
    digDeeper(ledger, file, { explorationId: exp.id, decidedBy: 'owner_ui', now: NOW });
    expect(ledger.decisions).toHaveLength(1);

    const scripted = scriptedLLM(
      [
        [
          {
            name: 'initiative_note',
            input: { exploration_id: exp.id, claim: 'c', source_ref: 's', confidence: 0.5 },
          },
        ],
        [],
      ],
      0.05,
    );
    const report = await harness({
      ledger,
      llm: scripted.llm,
      files: { [file.id]: file },
    }).runWindow(file.id, exp.id);
    expect(report.kind).toBe('window');
    expect(report.endReason).toBe('done');
    const row = ledger.getExploration(exp.id);
    // budget = spent so far + usd_per_exploration (1), deadline moved to now + default_days
    expect(row?.budgetUsd).toBeCloseTo(0.5 + 1, 5);
    expect(row?.deadline).toBe('2026-12-05T10:00:00.000Z');
    expect(row?.state).toBe('exploring');
  });

  it('the runner never reopens on its own: an exhausted briefed-then-exploring exploration stalls', async () => {
    const { ledger, file } = setup();
    const exp = ledger.seedExploration({
      id: 'EXP-1',
      initiativeId: file.id,
      state: 'exploring',
      budgetUsd: 0.5,
      spentUsd: 0.5,
    });
    // A brief exists, but no owner decision does.
    ledger.submitBrief({
      explorationId: exp.id,
      bodyMd: 'b',
      recommendedOption: 'r',
      partial: true,
    });
    const report = await harness({
      ledger,
      llm: scriptedLLM([[]], 0.01).llm,
      files: { [file.id]: file },
    }).runWindow(file.id, exp.id);
    expect(report.kind).toBe('brief');
    expect(ledger.getExploration(exp.id)?.budgetUsd).toBe(0.5);
  });

  it('a brief window that ends without a brief gets a partial brief from the runner', async () => {
    const { ledger, file } = setup();
    const exp = ledger.seedExploration({
      id: 'EXP-1',
      initiativeId: file.id,
      state: 'stalled',
      budgetUsd: 0.5,
      spentUsd: 0.5,
    });
    ledger.addFinding({
      explorationId: exp.id,
      claim: 'drop at step 2',
      sourceRef: 'u',
      confidence: 0.6,
    });
    // The scripted model writes text and never calls initiative_brief (nor sets partial).
    const report = await harness({
      ledger,
      llm: scriptedLLM([[]], 0.01).llm,
      files: { [file.id]: file },
    }).runWindow(file.id, exp.id);
    expect(report.kind).toBe('brief');
    expect(ledger.briefs).toHaveLength(1);
    expect(ledger.briefs[0]?.partial).toBe(true);
    expect(ledger.briefs[0]?.bodyMd).toContain('drop at step 2');
    expect(report.outcome).toBe('briefed');
    expect(ledger.getExploration(exp.id)?.state).toBe('briefed');
  });

  it('a non-partial brief on a stalled exploration is not accepted as the stall brief', () => {
    const { ledger, file } = setup();
    const exp = ledger.seedExploration({ id: 'EXP-1', initiativeId: file.id, state: 'stalled' });
    expect(() => settleWindow(ledger, exp.id, [{ partial: false }], NOW, 0.05)).toThrow(
      /not partial/,
    );
    expect(ledger.getExploration(exp.id)?.state).toBe('stalled');
  });
});
