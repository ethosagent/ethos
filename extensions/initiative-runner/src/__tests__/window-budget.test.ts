import { DefaultToolRegistry } from '@ethosagent/core';
import type { Tool } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { INITIATIVE_TOOL_CALL_USD } from '../index';
import { RESERVATION_TTL_MS } from '../runner';
import { fakeLedger, harness, ledgerTools, makeFile, scriptedLLM } from './helpers/fake-ledger';

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

describe('paid tool calls are charged before they run', () => {
  const search = { name: 'web_search', input: { query: 'q' } };

  function withSearch(ledger: ReturnType<typeof fakeLedger>) {
    let ran = 0;
    const stub: Tool = {
      name: 'web_search',
      description: 'web_search',
      toolset: 'web',
      capabilities: {},
      schema: { type: 'object', properties: {}, required: [] },
      async execute() {
        ran++;
        return { ok: true, value: 'results' };
      },
    };
    return {
      ran: () => ran,
      buildRegistry: ({ initiativeId }: { initiativeId: string }) => {
        const registry = new DefaultToolRegistry();
        for (const t of ledgerTools(ledger, initiativeId)) registry.register(t);
        registry.register(stub);
        return registry;
      },
    };
  }

  it("a tool's charge shows up in the window's spent_usd", async () => {
    const { file, ledger, exp } = setup(3);
    const spy = withSearch(ledger);
    const r = await harness({
      ledger,
      llm: scriptedLLM([[search], [search]], 0.001).llm,
      files: { [file.id]: file },
      extra: { buildRegistry: spy.buildRegistry },
    }).runWindow(file.id, exp.id);
    expect(spy.ran()).toBe(2);
    expect(r.spentUsd).toBeCloseTo(2 * (INITIATIVE_TOOL_CALL_USD.web_search ?? 0) + 3 * 0.001, 10);
    expect(ledger.windows[0]?.spentUsd).toBeCloseTo(r.spentUsd, 10);
  });

  it('search calls that push spend over the window cap stop the run before the next call', async () => {
    const { file, ledger, exp } = setup(3);
    const spy = withSearch(ledger);
    const price = INITIATIVE_TOOL_CALL_USD.web_search ?? 0;
    // Room for exactly two searches, then a third would cross the cap.
    const cap = 2.5 * price + 0.05;
    const turns = Array.from({ length: 10 }, () => [search]);
    const r = await harness({
      ledger,
      llm: scriptedLLM(turns, 0.001).llm,
      files: { [file.id]: file },
      extra: { buildRegistry: spy.buildRegistry },
    }).runWindow(file.id, exp.id, { capUsd: cap });
    expect(r.endReason).toBe('window');
    expect(spy.ran()).toBe(2);
    expect(r.spentUsd).toBeGreaterThanOrEqual(2 * price);
    expect(r.spentUsd).toBeLessThan(3 * price);
  });
});

describe('the reservation heartbeat', () => {
  it('extends the hold on every usage event and every paid tool charge', async () => {
    const { file, ledger, exp } = setup(5);
    const turns = [[note(exp.id)], [note(exp.id)], []];
    const { llm, calls } = scriptedLLM(turns, 0.01);
    await harness({ ledger, llm, files: { [file.id]: file } }).runWindow(file.id, exp.id);
    expect(calls()).toBeGreaterThan(0);
    expect(ledger.touches.length).toBeGreaterThanOrEqual(calls());
    expect(new Set(ledger.touches.map((t) => t.windowId))).toEqual(new Set(['W-1']));
    expect(ledger.touches.every((t) => t.ttlMs === RESERVATION_TTL_MS)).toBe(true);
  });
});
