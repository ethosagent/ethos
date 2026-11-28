import type { CompletionChunk, LLMProvider } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { createKeyedLock } from '../day-caps';
import { fakeLedger, harness, makeFile, scriptedLLM } from './helpers/fake-ledger';

/** Today's spend of another initiative, charged through the ledger the way a closed window is. */
function spend(ledger: ReturnType<typeof fakeLedger>, initiativeId: string, usd: number): void {
  const id = ledger.openWindow({ initiativeId, explorationId: null, kind: 'survey' });
  ledger.closeWindow(id, { spentUsd: usd, endReason: 'done' });
}

function setup() {
  const mine = makeFile({ id: 'mine' });
  const sibling = makeFile({ id: 'sibling' });
  const foreign = makeFile({ id: 'foreign' });
  const ledger = fakeLedger();
  ledger.seedInitiative(mine, 'product-manager');
  ledger.seedInitiative(sibling, 'product-manager');
  ledger.seedInitiative(foreign, 'writer');
  return { ledger, files: { mine, sibling, foreign } };
}

const run = async (
  ledger: ReturnType<typeof fakeLedger>,
  files: Record<string, ReturnType<typeof makeFile>>,
  initiatives: { maxUsdPerDay?: number; maxUsdPerDayPerPersonality?: number },
) => {
  const { llm, calls } = scriptedLLM([[]], 0.01);
  const report = await harness({
    ledger,
    llm,
    files,
    personalityIds: ['product-manager', 'writer'],
    extra: { constitution: async () => ({ initiatives }) },
  }).runSurvey('mine');
  return { report, calls: calls() };
};

describe('day totals across initiatives', () => {
  it("maxUsdPerDayPerPersonality counts the personality's other initiatives", async () => {
    const { ledger, files } = setup();
    spend(ledger, 'sibling', 0.98);
    const stopped = await run(ledger, files, { maxUsdPerDayPerPersonality: 1 });
    expect(stopped.report.endReason).toBe('day');
    expect(stopped.calls).toBe(0);

    // Another personality's spend does not count against this one.
    const { ledger: l2, files: f2 } = setup();
    spend(l2, 'foreign', 0.98);
    const free = await run(l2, f2, { maxUsdPerDayPerPersonality: 1 });
    expect(free.report.endReason).toBe('done');
  });

  it('maxUsdPerDay counts every personality', async () => {
    const { ledger, files } = setup();
    spend(ledger, 'foreign', 0.98);
    const stopped = await run(ledger, files, { maxUsdPerDay: 1 });
    expect(stopped.report.endReason).toBe('day');
    expect(stopped.calls).toBe(0);
  });

  it('no ceiling set means no total is enforced', async () => {
    const { ledger, files } = setup();
    spend(ledger, 'foreign', 50);
    expect((await run(ledger, files, {})).report.endReason).toBe('done');
  });
});

describe('runs that share a cap do not overlap', () => {
  it('the keyed lock runs same-key work one at a time, in order', async () => {
    const lock = createKeyedLock();
    const log: string[] = [];
    const task = (name: string, ms: number) => async () => {
      log.push(`${name}:start`);
      await new Promise((r) => setTimeout(r, ms));
      log.push(`${name}:end`);
    };
    await Promise.all([
      lock.run(['a', 'b'], task('one', 20)),
      lock.run(['b', 'a'], task('two', 1)),
      lock.run(['c'], task('free', 1)),
    ]);
    expect(log.indexOf('one:end')).toBeLessThan(log.indexOf('two:start'));
    expect(log.indexOf('free:start')).toBeLessThan(log.indexOf('one:end'));
  });

  it('two runs of one initiative: the second starts only after the first closed its window', async () => {
    const { ledger, files } = setup();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const events: string[] = [];
    let n = 0;
    const llm: LLMProvider = {
      name: 'gated',
      model: 'mock-model',
      maxContextTokens: 200_000,
      supportsCaching: false,
      supportsThinking: false,
      async *complete(): AsyncIterable<CompletionChunk> {
        const me = ++n;
        events.push(`call${me}:start`);
        if (me === 1) await gate;
        yield {
          type: 'usage',
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            estimatedCostUsd: 0.01,
          },
        };
        yield { type: 'text_delta', text: 'ok' };
        yield { type: 'done', finishReason: 'end_turn' };
      },
      async countTokens() {
        return 1;
      },
    };
    const runner = harness({ ledger, llm, files });
    const first = runner.runSurvey('mine');
    const second = runner.runSurvey('mine');
    await new Promise((r) => setTimeout(r, 30));
    expect(events).toEqual(['call1:start']);
    release();
    await Promise.all([first, second]);
    expect(events).toEqual(['call1:start', 'call2:start']);
    // The second run saw the first one's spend (it read the day's money after it closed).
    expect(ledger.windows.map((w) => w.spentUsd)).toEqual([0.01, 0.01]);
  });
});

describe('cross-process reservation', () => {
  it('a run reserves what its guard allows and a refusal opens no window', async () => {
    const { ledger, files } = setup();
    const ok = await run(ledger, files, { maxUsdPerDay: 5 });
    expect(ok.report.endReason).toBe('done');
    // The survey cap ($1) is the tightest ceiling, so that is what is held.
    expect(ledger.reservations).toMatchObject([{ initiativeId: 'mine', reserveUsd: 1 }]);

    const { ledger: l2, files: f2 } = setup();
    l2.refusal.scope = 'global';
    const { llm, calls } = scriptedLLM([[]], 0.01);
    await expect(
      harness({
        ledger: l2,
        llm,
        files: f2,
        personalityIds: ['product-manager', 'writer'],
      }).runSurvey('mine'),
    ).rejects.toThrow(/global day cap/);
    expect(l2.windows).toHaveLength(0);
    expect(calls()).toBe(0);
  });
});
