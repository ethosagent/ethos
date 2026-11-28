import { describe, expect, it } from 'vitest';
import { fakeLedger, harness, makeFile, scriptedLLM } from './helpers/fake-ledger';

const note = (id: string) => ({
  name: 'initiative_note',
  input: { exploration_id: id, claim: 'c', source_ref: 's', confidence: 0.5 },
});

function setup(usdPerDay: number) {
  const file = makeFile({
    budget: { usd_per_day: usdPerDay, usd_per_exploration: 10, max_open_explorations: 3 },
  });
  const ledger = fakeLedger();
  ledger.seedInitiative(file);
  const exp = ledger.seedExploration({ id: 'EXP-1', initiativeId: file.id, budgetUsd: 10 });
  return { file, ledger, exp };
}

describe('exploration window budget', () => {
  it('stops at the per-window cap that planDay computed', async () => {
    const { file, ledger, exp } = setup(3);
    const turns = Array.from({ length: 12 }, () => [note(exp.id)]);
    const r = await harness({
      ledger,
      llm: scriptedLLM(turns, 0.1).llm,
      files: { [file.id]: file },
    }).runWindow(file.id, exp.id, { capUsd: 0.3 });
    expect(r.endReason).toBe('window');
    expect(r.spentUsd).toBeCloseTo(0.3, 10);
  });

  it('leaves the brief reserve in the day so a partial brief can still be written', async () => {
    // usd_per_day 2 holds back 0.15 x 2 = 0.3, so a window may use 1.7 of the day (plus one call).
    const { file, ledger, exp } = setup(2);
    const turns = Array.from({ length: 12 }, () => [note(exp.id)]);
    const r = await harness({
      ledger,
      llm: scriptedLLM(turns, 0.6).llm,
      files: { [file.id]: file },
    }).runWindow(file.id, exp.id);
    expect(r.endReason).toBe('day');
    expect(r.spentUsd).toBeCloseTo(1.8, 10);
    // Without the reserve a fourth call would have run (1.8 leaves 0.2 of the day), ending at 2.4.
  });

  it("a stalled exploration's brief run is not stopped by the per-window cap", async () => {
    // The cap was sized for an exploring window; the brief spends the reserve kept for it.
    const { file, ledger } = setup(3);
    const stalled = ledger.seedExploration({
      id: 'EXP-2',
      initiativeId: file.id,
      budgetUsd: 10,
      state: 'stalled',
    });
    const turns = Array.from({ length: 12 }, () => [note(stalled.id)]);
    const r = await harness({
      ledger,
      llm: scriptedLLM(turns, 0.2).llm,
      files: { [file.id]: file },
    }).runWindow(file.id, stalled.id, { capUsd: 0.3 });
    expect(r.kind).toBe('brief');
    expect(r.endReason).not.toBe('window');
    expect(r.spentUsd).toBeGreaterThan(0.3);
  });
});
