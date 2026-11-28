import { describe, expect, it } from 'vitest';
import { fakeLedger, harness, makeFile, scriptedLLM } from './helpers/fake-ledger';

function setup() {
  const file = makeFile({
    budget: { usd_per_day: 5, usd_per_exploration: 10, max_open_explorations: 3 },
  });
  const ledger = fakeLedger();
  ledger.seedInitiative(file);
  const exp = ledger.seedExploration({ id: 'EXP-1', initiativeId: file.id, budgetUsd: 10 });
  return { file, ledger, exp };
}

describe('an external abort signal ends a run through closeWindow', () => {
  it('closes the window (which releases the reservation) when the signal fires', async () => {
    const { file, ledger, exp } = setup();
    const ctl = new AbortController();
    ctl.abort(); // Ctrl-C before the first call
    const r = await harness({
      ledger,
      llm: scriptedLLM([[]], 0.01).llm,
      files: { [file.id]: file },
    }).runWindow(file.id, exp.id, { signal: ctl.signal });
    expect(ledger.reservations).toHaveLength(1);
    expect(ledger.windows[0]?.endReason).toBe('aborted');
    expect(r.endReason).toBe('aborted');
  });

  it('a signal that fires mid-run stops the loop and still closes the window', async () => {
    const { file, ledger, exp } = setup();
    const ctl = new AbortController();
    const note = {
      name: 'initiative_note',
      input: { exploration_id: exp.id, claim: 'c', source_ref: 's', confidence: 0.5 },
    };
    const { llm, calls } = scriptedLLM(
      Array.from({ length: 8 }, () => [note]),
      0.01,
    );
    const first = llm.complete.bind(llm);
    llm.complete = (...a) => {
      ctl.abort(); // the first model call is where Ctrl-C lands
      return first(...a);
    };
    const r = await harness({ ledger, llm, files: { [file.id]: file } }).runSurvey(file.id, {
      signal: ctl.signal,
    });
    expect(calls()).toBeLessThan(8);
    expect(r.endReason).toBe('aborted');
    expect(ledger.windows[0]?.endReason).toBe('aborted');
  });
});
