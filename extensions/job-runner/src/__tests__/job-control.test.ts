// plan background-job-steer §5.6 / §6.4 — JobControl: one owner for the
// request policy (audience gate D11, capability D16, status, remote, tail).

import { SQLiteJobStore } from '@ethosagent/job-store';
import type {
  BackgroundJob,
  CreateBackgroundJobInput,
  JobRunner,
  JobRunnerRegistry,
  RunnerCapabilities,
  TurnAudience,
} from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import { createJobControl, ETHOS_RUNNER_CAPABILITIES, jobActionAllowed } from '../index';

function input(over?: Partial<CreateBackgroundJobInput>): CreateBackgroundJobInput {
  return {
    owner: 'o',
    parentSessionKey: 'p',
    rootSessionKey: 'r',
    childSessionKey: 'c',
    depth: 1,
    prompt: 'x',
    roomAudience: 'private',
    ...over,
  };
}

async function running(store: SQLiteJobStore, over?: Partial<CreateBackgroundJobInput>) {
  await store.create(input(over));
  const job = await store.claimNextQueued('o');
  if (!job) throw new Error('claim failed');
  return job;
}

function registryOf(runner: Partial<JobRunner> & { capabilities: RunnerCapabilities }) {
  return {
    get: (name: string) => (name === runner.name ? (runner as JobRunner) : undefined),
  } as unknown as JobRunnerRegistry;
}

const acpLike: RunnerCapabilities = { ...ETHOS_RUNNER_CAPABILITIES, steer: false };
const AUD: TurnAudience[] = ['shared', 'private'];

describe('jobActionAllowed', () => {
  it('shared×private refused; shared×shared, private×private, private×shared allowed', () => {
    const priv = { roomAudience: 'private' } as BackgroundJob;
    const shared = { roomAudience: 'shared' } as BackgroundJob;
    expect(jobActionAllowed(priv, 'shared')).toBe(false);
    expect(jobActionAllowed(shared, 'shared')).toBe(true);
    expect(jobActionAllowed(priv, 'private')).toBe(true);
    expect(jobActionAllowed(shared, 'private')).toBe(true);
  });

  it('an unstamped legacy row from a group origin is shared', () => {
    const legacy = { originPlatform: 'telegram', originChatId: '-100123' } as BackgroundJob;
    expect(jobActionAllowed(legacy, 'shared')).toBe(true);
  });
});

describe('JobControl audience refusal looks like "no such job"', () => {
  it('a shared requester gets not_found for steer, stop and tail on a private job', async () => {
    const store = new SQLiteJobStore(':memory:');
    const job = await running(store);
    const poke = vi.fn();
    const ctl = createJobControl({ store, executor: { pokeSteer: poke } });
    expect(
      await ctl.steer(job, { text: 'x', source: 'gateway', requesterAudience: 'shared' }),
    ).toEqual({
      ok: false,
      reason: 'not_found',
    });
    expect(await ctl.stop(job, { requesterAudience: 'shared' })).toEqual({
      ok: false,
      reason: 'not_found',
    });
    expect(await ctl.tail(job, { requesterAudience: 'shared', audience: 'channel' })).toEqual({
      ok: false,
      reason: 'not_found',
    });
    expect((await store.get(job.id))?.cancelRequested).toBeFalsy();
    expect(await store.listSteers?.(job.id)).toEqual([]);
    expect(poke).not.toHaveBeenCalled();
  });

  it('shared×shared and private×shared are allowed', async () => {
    const store = new SQLiteJobStore(':memory:');
    const job = await running(store, { roomAudience: 'shared' });
    const ctl = createJobControl({ store });
    for (const aud of AUD) {
      const r = await ctl.steer(job, { text: 'hi', source: 'cli', requesterAudience: aud });
      expect(r.ok).toBe(true);
    }
  });
});

describe('JobControl.steer', () => {
  it('pokes the executor on success', async () => {
    const store = new SQLiteJobStore(':memory:');
    const job = await running(store);
    const poke = vi.fn();
    const ctl = createJobControl({ store, executor: { pokeSteer: poke } });
    const r = await ctl.steer(job, { text: 'go', source: 'web', requesterAudience: 'private' });
    expect(r.ok).toBe(true);
    expect(poke).toHaveBeenCalledWith(job.id);
  });

  it('unsupported for a row naming an unresolved runner and for an ACP-caps runner', async () => {
    const store = new SQLiteJobStore(':memory:');
    const ghost = await running(store, { runner: 'ghost' });
    const ctl = createJobControl({ store });
    expect(
      await ctl.steer(ghost, { text: 'x', source: 'cli', requesterAudience: 'private' }),
    ).toEqual({
      ok: false,
      reason: 'unsupported',
    });

    const store2 = new SQLiteJobStore(':memory:');
    const claude = await running(store2, { runner: 'claude' });
    const ctl2 = createJobControl({
      store: store2,
      runners: registryOf({ name: 'claude', capabilities: acpLike }),
    });
    expect(
      await ctl2.steer(claude, { text: 'x', source: 'cli', requesterAudience: 'private' }),
    ).toEqual({ ok: false, reason: 'unsupported' });
    expect(await store2.listSteers?.(claude.id)).toEqual([]);
  });

  it('remote and finished are reported with the status', async () => {
    const store = new SQLiteJobStore(':memory:');
    const done = await running(store);
    await store.finish(done.id, 'done', { summary: 's' });
    const ctl = createJobControl({ store });
    expect(
      await ctl.steer(done, { text: 'x', source: 'cli', requesterAudience: 'private' }),
    ).toEqual({
      ok: false,
      reason: 'finished',
      status: 'done',
    });
  });

  it('remote proxy rows are refused for steer and stop', async () => {
    const store = new SQLiteJobStore(':memory:');
    const job = await running(store, { remoteJobId: 'peer-1' });
    const ctl = createJobControl({ store });
    expect(
      await ctl.steer(job, { text: 'x', source: 'cli', requesterAudience: 'private' }),
    ).toEqual({
      ok: false,
      reason: 'remote',
    });
    expect(await ctl.stop(job, { requesterAudience: 'private' })).toEqual({
      ok: false,
      reason: 'remote',
    });
  });

  it('not_available when the store lacks the steer queue', async () => {
    const real = new SQLiteJobStore(':memory:');
    const job = await running(real);
    const bare = new Proxy(real, {
      get: (t, p, r) => (p === 'addSteer' ? undefined : Reflect.get(t, p, r)),
    });
    const ctl = createJobControl({ store: bare });
    expect(
      await ctl.steer(job, { text: 'x', source: 'cli', requesterAudience: 'private' }),
    ).toEqual({
      ok: false,
      reason: 'not_available',
    });
  });

  it('capabilitiesFor: default and unnamed runners get the Ethos caps, unknown gets null', async () => {
    const store = new SQLiteJobStore(':memory:');
    const ctl = createJobControl({ store });
    expect(ctl.capabilitiesFor({} as BackgroundJob)).toBe(ETHOS_RUNNER_CAPABILITIES);
    expect(ctl.capabilitiesFor({ runner: 'ethos' } as BackgroundJob)).toBe(
      ETHOS_RUNNER_CAPABILITIES,
    );
    expect(ctl.capabilitiesFor({ runner: 'nope' } as BackgroundJob)).toBeNull();
  });
});

describe('JobControl.stop', () => {
  it('requests cancel, pokes, and refuses a terminal row with finished', async () => {
    const store = new SQLiteJobStore(':memory:');
    const job = await running(store);
    const poke = vi.fn();
    const ctl = createJobControl({ store, executor: { pokeSteer: poke } });
    expect(await ctl.stop(job, { requesterAudience: 'private' })).toEqual({
      ok: true,
      wasRunning: true,
    });
    expect((await store.get(job.id))?.cancelRequested).toBe(true);
    expect(poke).toHaveBeenCalledWith(job.id);

    await store.finish(job.id, 'aborted', { error: 'cancelled by task_cancel' });
    // The caller's copy is stale (still 'running'); the stored row decides.
    expect(await ctl.stop(job, { requesterAudience: 'private' })).toEqual({
      ok: false,
      reason: 'finished',
      status: 'aborted',
    });
  });
});

describe('JobControl.tail', () => {
  it('channel drops runner_log and artifact_change; operator keeps them; afterSeq pages forward', async () => {
    const store = new SQLiteJobStore(':memory:');
    const job = await running(store);
    await store.appendEvent(job.id, 'text', { text: 'hello' });
    await store.appendEvent(job.id, 'runner_log', { stream: 'stdout', text: 'secret' });
    await store.appendEvent(job.id, 'artifact_change', { path: 'a.ts' });
    await store.appendEvent(job.id, 'tool_headline', { toolName: 'ls', arg: '.' });
    const ctl = createJobControl({ store });

    const ch = await ctl.tail(job, { requesterAudience: 'private', audience: 'channel' });
    if (!ch.ok) throw new Error('tail refused');
    const kinds = ch.events.map((e) => e.eventType);
    expect(kinds).not.toContain('runner_log');
    expect(kinds).not.toContain('artifact_change');
    expect(kinds).toContain('text');
    expect(kinds).toContain('tool_headline');

    const op = await ctl.tail(job, { requesterAudience: 'private', audience: 'operator' });
    if (!op.ok) throw new Error('tail refused');
    expect(op.events.map((e) => e.eventType)).toEqual(
      expect.arrayContaining(['runner_log', 'artifact_change']),
    );

    const cut = op.events[0]?.seq ?? 0;
    const after = await ctl.tail(job, {
      requesterAudience: 'private',
      audience: 'operator',
      afterSeq: cut,
    });
    if (!after.ok) throw new Error('tail refused');
    expect(after.events.every((e) => e.seq > cut)).toBe(true);
    expect(after.events.length).toBe(op.events.length - 1);
  });

  it('channel limit defaults to 10', async () => {
    const store = new SQLiteJobStore(':memory:');
    const job = await running(store);
    for (let i = 0; i < 25; i++) await store.appendEvent(job.id, 'text', { text: `t${i}` });
    const ctl = createJobControl({ store });
    const ch = await ctl.tail(job, { requesterAudience: 'private', audience: 'channel' });
    if (!ch.ok) throw new Error('tail refused');
    expect(ch.events).toHaveLength(10);
  });

  it('channel tail over-fetches so many runner_log rows do not hide earlier text rows', async () => {
    const store = new SQLiteJobStore(':memory:');
    const job = await running(store);
    for (let i = 0; i < 5; i++) await store.appendEvent(job.id, 'text', { text: `t${i}` });
    for (let i = 0; i < 30; i++) {
      await store.appendEvent(job.id, 'runner_log', { stream: 'stdout', text: `l${i}` });
    }
    const ctl = createJobControl({ store });
    const ch = await ctl.tail(job, { requesterAudience: 'private', audience: 'channel' });
    if (!ch.ok) throw new Error('tail refused');
    const kinds = ch.events.map((e) => e.eventType);
    expect(kinds.filter((k) => k === 'text')).toHaveLength(5);
    expect(kinds).not.toContain('runner_log');
  });
});
