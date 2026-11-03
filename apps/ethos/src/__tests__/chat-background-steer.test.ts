// plan background-job-steer §5.3 CLI / D10 / D13 — `/background steer|stop|tail`
// and the `/steer <ref>` alias resolve a ref inside the REPL's own root only;
// a sub-word without a ref-shaped token stays a `/background <prompt>`.

import { createJobControl, SQLiteJobStore } from '@ethosagent/wiring';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleBackgroundCommand, steerJobFromSlash } from '../commands/chat';

const ROOT = 'cli:mine';
const OTHER = 'cli:other';

let store: SQLiteJobStore;
let nudge: ReturnType<typeof vi.fn>;
let written: string;

function mkState(extra: { control?: boolean } = {}) {
  const control = createJobControl({ store });
  return {
    sessionKey: ROOT,
    jobStore: store,
    backgroundExecutor: { owner: 'o', nudge, pokeSteer: vi.fn() },
    ...(extra.control === false ? {} : { jobControl: control }),
  } as unknown as Parameters<typeof handleBackgroundCommand>[1];
}

async function seed(root: string, prompt = 'job') {
  const j = await store.create({
    owner: 'o',
    parentSessionKey: root,
    rootSessionKey: root,
    childSessionKey: `${root}:c:${Math.random()}`,
    depth: 0,
    prompt,
    roomAudience: 'private',
  });
  return j;
}

async function running(root: string) {
  await seed(root);
  const claimed = await store.claimNextQueued('o');
  if (!claimed) throw new Error('claim failed');
  return claimed;
}

beforeEach(() => {
  store = new SQLiteJobStore(':memory:');
  nudge = vi.fn();
  written = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((s: string | Uint8Array) => {
    written += String(s);
    return true;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('/background steer', () => {
  it('queues a steer for a job in this root, by 8-char prefix', async () => {
    const job = await running(ROOT);
    await handleBackgroundCommand(`steer ${job.id.slice(0, 8)} skip the tests`, mkState());
    expect(written).toContain(`noted for job ${job.id.slice(0, 8)}`);
    const steers = await store.listSteers?.(job.id);
    expect(steers?.map((s) => [s.text, s.source])).toEqual([['skip the tests', 'cli']]);
    expect(nudge).not.toHaveBeenCalled();
  });

  it('a job of another root is not found and nothing is queued', async () => {
    const other = await running(OTHER);
    await handleBackgroundCommand(`steer ${other.id} hello`, mkState());
    expect(written).toContain('no job');
    expect(await store.listSteers?.(other.id)).toEqual([]);
  });

  it('treats a non-ref sub-word as a prompt: creates a job', async () => {
    await handleBackgroundCommand('steer the boat', mkState());
    const jobs = await store.listByRoot(ROOT);
    expect(jobs.map((j) => j.prompt)).toEqual(['steer the boat']);
    expect(nudge).toHaveBeenCalled();
  });

  it('prints usage for a ref with no text and creates nothing', async () => {
    const job = await running(ROOT);
    await handleBackgroundCommand(`steer ${job.id.slice(0, 8)}`, mkState());
    expect(written).toContain('Usage: /background steer');
    expect(await store.listByRoot(ROOT)).toHaveLength(1);
  });
});

describe('/background stop and cancel', () => {
  it('stop requests cancel for a job in this root', async () => {
    const job = await running(ROOT);
    await handleBackgroundCommand(`stop ${job.id.slice(0, 8)}`, mkState());
    expect(written).toContain(`Stopping job ${job.id.slice(0, 8)}`);
    expect((await store.get(job.id))?.cancelRequested).toBe(true);
  });

  it('cancel stays an alias of stop', async () => {
    const job = await running(ROOT);
    await handleBackgroundCommand(`cancel ${job.id}`, mkState());
    expect((await store.get(job.id))?.cancelRequested).toBe(true);
  });

  it('cancel <other-root-id> is not found and does not cancel (D10)', async () => {
    const other = await running(OTHER);
    await handleBackgroundCommand(`cancel ${other.id}`, mkState());
    expect(written).toContain('no job');
    expect((await store.get(other.id))?.cancelRequested).toBeFalsy();
  });

  it('stop on a finished job says so', async () => {
    const job = await running(ROOT);
    await store.finish(job.id, 'done', { summary: 's' });
    await handleBackgroundCommand(`stop ${job.id}`, mkState());
    expect(written).toContain('already finished (done)');
  });
});

describe('/background tail', () => {
  it('prints the header and the operator tail for a job in this root', async () => {
    const job = await running(ROOT);
    await store.appendEvent(job.id, 'tool_headline', { toolName: 'bash', arg: 'ls' });
    await handleBackgroundCommand(`tail ${job.id.slice(0, 8)}`, mkState());
    expect(written).toContain(`job ${job.id.slice(0, 8)} · running · $0.0000`);
    expect(written).toContain('tool: bash ls');
  });

  it('another root is not found', async () => {
    const other = await running(OTHER);
    await handleBackgroundCommand(`tail ${other.id}`, mkState());
    expect(written).toContain('no job');
    expect(written).not.toContain('running');
  });
});

describe('/steer <ref> <text>', () => {
  it('steers the job when the first token resolves in scope', async () => {
    const job = await running(ROOT);
    const handled = await steerJobFromSlash(`${job.id.slice(0, 8)} use staging`, mkState());
    expect(handled).toBe(true);
    expect((await store.listSteers?.(job.id))?.map((s) => s.text)).toEqual(['use staging']);
  });

  it('falls through when the hex does not resolve', async () => {
    await running(ROOT);
    expect(await steerJobFromSlash('deadbeef x', mkState())).toBe(false);
    expect(written).toBe('');
  });

  it('falls through for an id from another root', async () => {
    const other = await running(OTHER);
    expect(await steerJobFromSlash(`${other.id} x`, mkState())).toBe(false);
    expect(await store.listSteers?.(other.id)).toEqual([]);
  });

  it('falls through for plain foreground text and without jobControl', async () => {
    const job = await running(ROOT);
    expect(await steerJobFromSlash('use the other approach', mkState())).toBe(false);
    expect(await steerJobFromSlash(`${job.id} x`, mkState({ control: false }))).toBe(false);
  });
});
