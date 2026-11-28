import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InitiativeConfigService, type InitiativeRunner } from '@ethosagent/initiative-runner';
import { FsStorage } from '@ethosagent/storage-fs';
import { EthosError } from '@ethosagent/types';
import {
  createInitiativeCliPort,
  type InitiativeCliPort,
  initiativesDbPath,
  SQLiteInitiativeStore,
} from '@ethosagent/wiring';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runManageCommand } from '../../lib/initiatives-manage';
import { parseRunArgs, runInitiativesCommand } from '../initiatives';

const YAML_DRAFT = {
  id: 'grow',
  version: 1,
  origin: 'human',
  created_in: 'web',
  state: 'active',
  title: 'Grow signups',
  outcome: 'More trials',
  sources: ['web'],
  exclude: [],
  guidance: [],
  autonomy: { mode: 'ask' },
  budget: { usd_per_day: 2, usd_per_exploration: 1, max_open_explorations: 2 },
  timeline: {
    explore_windows: ['every 2h'],
    window_minutes: 20,
    default_days: 14,
    review_on: '2026-12-20',
  },
  delivery: { owner_channel: 'telegram:1', digest_time: '09:00' },
};

let dir: string;
let port: InitiativeCliPort | null;
const storage = new FsStorage();
const run = (args: string[], over: { personalityId?: string } = {}) =>
  runManageCommand(args, port, { personalityId: over.personalityId ?? 'pm' });

/** Seed through the real owners: the config service writes the YAML, the store holds the rows. */
async function seed(): Promise<{ proposed: string; briefed: string }> {
  const store = new SQLiteInitiativeStore(initiativesDbPath(dir), { explorationCapFor: () => 5 });
  const svc = new InitiativeConfigService({
    storage,
    dataDir: dir,
    store,
    constitution: async () => ({}),
    settings: async () => ({
      enabled: true,
      selfStart: false,
      dailyBudgetUsd: 0,
      standingGuidance: [],
    }),
    toolset: () => ['web_search'],
    schedule: () => {},
  });
  const saved = await svc.save({
    personalityId: 'pm',
    op: 'create',
    draft: YAML_DRAFT,
    sessionId: 's',
    confirmedBy: 'owner_chat',
  });
  expect(saved).toMatchObject({ ok: true });
  const propose = (q: string) =>
    store.propose({ initiativeId: 'grow', ideaId: null, question: q, estimateUsd: 1, days: 7 });
  const proposed = propose('Which channel converts?');
  const briefed = propose('Is pricing the blocker?');
  store.transitionExploration(briefed.id, 'exploring', 'x');
  store.transitionExploration(briefed.id, 'briefed', 'x');
  store.submitBrief({
    explorationId: briefed.id,
    bodyMd: '## Findings\n\nPricing is not the blocker.',
    recommendedOption: 'A',
    partial: false,
  });
  store.upsertInitiative({
    id: 'scout',
    personalityId: 'pm',
    origin: 'agent',
    parentId: 'grow',
    state: 'self_started',
    configPath: join(dir, 'none.yaml'),
    configHash: 'h',
    version: 1,
  });
  store.close();
  port = await createInitiativeCliPort({ storage, dataDir: dir });
  return { proposed: proposed.id, briefed: briefed.id };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ethos-initiatives-cli-'));
  port = null;
});
afterEach(() => {
  port?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('ethos initiatives (manage)', () => {
  it('list shows an origin column with id, personality, state and title', async () => {
    await seed();
    const out = await run(['list']);
    expect(out.lines[0]).toContain('origin');
    expect(out.lines.join('\n')).toContain('grow  human  pm  active  Grow signups');
    expect(out.lines.join('\n')).toMatch(/scout {2}agent {2}pm {2}self_started/);
  });

  it('show prints every initiative-file key', async () => {
    await seed();
    const text = (await run(['show', 'grow'])).lines.join('\n');
    for (const key of Object.keys(YAML_DRAFT)) expect(text).toContain(`${key}:`);
    expect(text).toContain('EXP-0001');
  });

  it('export prints the brief as Markdown and writes no file', async () => {
    const { briefed } = await seed();
    const before = readdirSync(dir).sort();
    const out = await run(['export', briefed]);
    expect(out.raw).toContain('# Is pricing the blocker?');
    expect(out.raw).toContain('Pricing is not the blocker.');
    expect(readdirSync(dir).sort()).toEqual(before);
  });

  it('pause and resume go through the config service', async () => {
    await seed();
    await run(['pause', 'grow']);
    expect(port?.store.getInitiative('grow')?.state).toBe('paused');
    expect((await port?.file('grow'))?.state).toBe('paused');
    await run(['resume', 'grow']);
    expect(port?.store.getInitiative('grow')?.state).toBe('active');
  });

  it('pause and resume are confirmed as owner_cli', async () => {
    await seed();
    const save = vi.spyOn(port?.config as NonNullable<typeof port>['config'], 'save');
    await run(['pause', 'grow']);
    await run(['resume', 'grow']);
    expect(save.mock.calls.map(([i]) => i.confirmedBy)).toEqual(['owner_cli', 'owner_cli']);
  });

  it('deny, park and stop pass --reason through to the decision row', async () => {
    const { proposed } = await seed();
    await run(['deny', proposed, '--reason', 'too pricey']);
    port?.store.upsertInitiative({
      id: 'scout2',
      personalityId: 'pm',
      origin: 'agent',
      parentId: 'grow',
      state: 'self_started',
      configPath: join(dir, 'none.yaml'),
      configHash: 'h',
      version: 1,
    });
    await run(['stop', 'scout2', '--reason', 'off topic']);
    const store = new SQLiteInitiativeStore(initiativesDbPath(dir), { explorationCapFor: () => 5 });
    const reasons = store
      .decisionsSince('pm', '1970-01-01T00:00:00.000Z')
      .map((d) => [d.verdict, d.reason]);
    store.close();
    expect(reasons).toEqual(
      expect.arrayContaining([
        ['reject', 'too pricey'],
        ['stop', 'off topic'],
      ]),
    );
  });

  it('park passes --reason too', async () => {
    const { briefed } = await seed();
    await run(['park', briefed, '--reason', 'later']);
    const store = new SQLiteInitiativeStore(initiativesDbPath(dir), { explorationCapFor: () => 5 });
    const rows = store.decisionsSince('pm', '1970-01-01T00:00:00.000Z');
    store.close();
    expect(rows.find((d) => d.verdict === 'park')?.reason).toBe('later');
  });

  it('metrics shows gate rates and spend', async () => {
    const { proposed, briefed } = await seed();
    await run(['approve', proposed]);
    await run(['adopt', briefed]);
    const w = port?.store.openWindow({ initiativeId: 'grow', explorationId: null, kind: 'survey' });
    port?.store.closeWindow(w ?? '', {
      spentUsd: 0.25,
      toolsUsed: [],
      reads: [],
      checkpoint: null,
      endReason: 'done',
    });
    const text = (await run(['metrics'])).lines.join('\n');
    expect(text).toContain('Gate 1 approve rate: 100% (1 of 1)');
    expect(text).toContain('Gate 2 approve rate: 100% (1 of 1)');
    expect(text).toContain('Spend: $0.2500');
  });

  it('approve and deny record gate 1 decisions as owner:cli and refuse a wrong state', async () => {
    const { proposed, briefed } = await seed();
    await run(['approve', proposed]);
    expect(port?.store.getExploration(proposed)?.state).toBe('exploring');
    const err = await run(['approve', briefed]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EthosError);
    expect((err as EthosError).cause).toContain('is briefed, not proposed');
    const second = port?.store.propose({
      initiativeId: 'grow',
      ideaId: null,
      question: 'q',
      estimateUsd: 1,
      days: 1,
    });
    await run(['deny', second?.id ?? '']);
    expect(port?.store.getExploration(second?.id ?? '')?.state).toBe('rejected');
    expect(port?.metrics('pm', '1970-01-01T00:00:00.000Z').gate1).toMatchObject({
      asked: 2,
      approved: 1,
    });
  });

  it('adopt keeps the option, park parks, both refuse an exploring target', async () => {
    const { proposed, briefed } = await seed();
    const err = await run(['adopt', proposed]).catch((e: unknown) => e);
    expect((err as EthosError).cause).toContain(`${proposed} is proposed, not briefed`);
    const out = await run(['adopt', briefed, '--option', 'B']);
    expect(out.data).toMatchObject({ verdict: 'adopt', option: 'B' });
    expect(port?.store.getExploration(briefed)?.state).toBe('adopted');
    const again = port?.store.propose({
      initiativeId: 'grow',
      ideaId: null,
      question: 'q',
      estimateUsd: 1,
      days: 1,
    });
    port?.store.transitionExploration(again?.id ?? '', 'exploring', 'x');
    port?.store.transitionExploration(again?.id ?? '', 'briefed', 'x');
    await run(['park', again?.id ?? '']);
    expect(port?.store.getExploration(again?.id ?? '')?.state).toBe('parked');
  });

  it('dig-deeper reopens a briefed exploration with a new budget', async () => {
    const { briefed } = await seed();
    const out = await run(['dig-deeper', briefed], {});
    expect(port?.store.getExploration(briefed)).toMatchObject({ state: 'exploring', budgetUsd: 1 });
    expect(out.data).toMatchObject({ verdict: 'dig_deeper' });
  });

  it('keep and stop decide a self-started initiative; make-mine points at chat', async () => {
    await seed();
    const hint = await run(['make-mine', 'scout']);
    expect(hint.lines.join('\n')).toContain('chat');
    await run(['keep', 'scout']);
    expect(port?.store.getInitiative('scout')?.state).toBe('active');
    const err = await run(['stop', 'scout']).catch((e: unknown) => e);
    expect((err as EthosError).cause).toContain('is active, not self_started');
  });

  it('run --scan calls the scan entry point', async () => {
    expect(parseRunArgs(['run', 'grow', '--scan'])).toEqual({ kind: 'scan', initiativeId: 'grow' });
    const runScan = vi.fn(async () => ({
      windowId: 'W-1',
      kind: 'scan' as const,
      initiativeId: 'grow',
      explorationId: null,
      spentUsd: 0,
      endReason: 'done',
      toolsUsed: [],
      reads: [],
      proposals: [],
      ideas: [],
      findings: [],
      text: '',
      started: [],
      waiting: [],
      outcome: null,
      drafts: [],
    }));
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runInitiativesCommand(['run', 'grow', '--scan'], {
      runScan,
    } as unknown as InitiativeRunner);
    spy.mockRestore();
    expect(runScan).toHaveBeenCalledWith('grow');
  });

  it('refuses an unknown subcommand and a missing db with EthosError, list is empty without a db', async () => {
    expect(await run(['list'])).toMatchObject({ lines: ['No initiatives saved.'] });
    await expect(run(['show', 'x'])).rejects.toBeInstanceOf(EthosError);
    await expect(run(['bogus'])).rejects.toBeInstanceOf(EthosError);
  });
});
