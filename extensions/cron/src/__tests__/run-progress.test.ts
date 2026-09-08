// Cron run progress capture — the recorder's audience gate and retention cap,
// the sidecar round-trip, and the guarantee that none of it reaches `output`.

import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import type { AgentEvent } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CronJob, CronRunResult, CronSchedulerConfig } from '../index';
import {
  CronProgressRecorder,
  CronScheduler,
  decideEscalation,
  formatRunProgress,
  PROGRESS_ELISION_TOOL,
  PROGRESS_HEAD_LIMIT,
  PROGRESS_MESSAGE_MAX_CHARS,
  PROGRESS_SUFFIX,
  PROGRESS_TAIL_LIMIT,
  parseRunProgress,
} from '../index';

let testDir: string;
let storage: InMemoryStorage;

beforeEach(async () => {
  testDir = join(tmpdir(), `ethos-cron-progress-${Date.now()}-${Math.random()}`);
  await mkdir(testDir, { recursive: true });
  storage = new InMemoryStorage();
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

function progressEvent(message: string, audience: 'user' | 'internal' = 'user'): AgentEvent {
  return { type: 'tool_progress', toolName: 'harvest', message, audience };
}

function makeScheduler(opts: Partial<CronSchedulerConfig>): CronScheduler {
  return new CronScheduler({
    cronDir: testDir,
    tickIntervalMs: 999_999,
    storage,
    runJob: async (job): Promise<CronRunResult> => ({
      jobId: job.id,
      ranAt: new Date().toISOString(),
      output: `ran: ${job.prompt}`,
      sessionKey: `cron:${job.id}`,
    }),
    ...opts,
  });
}

// ---------------------------------------------------------------------------
// The audience boundary (Phase 30.2)
// ---------------------------------------------------------------------------

describe('CronProgressRecorder audience gate', () => {
  it('records audience:user progress', () => {
    const rec = new CronProgressRecorder();
    rec.record(progressEvent('reddit: 42 posts'));
    const snap = rec.snapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0]?.toolName).toBe('harvest');
    expect(snap[0]?.message).toBe('reddit: 42 posts');
    expect(typeof snap[0]?.at).toBe('string');
  });

  it('does NOT record audience:internal progress', () => {
    const rec = new CronProgressRecorder();
    rec.record(progressEvent('cache warmed', 'internal'));
    expect(rec.snapshot()).toEqual([]);
  });

  it('does NOT record a tool_progress with an absent audience', () => {
    const rec = new CronProgressRecorder();
    // Deliberately malformed — a hand-rolled emitter that forgot the field
    // must not slip past the gate by omission.
    rec.record({ type: 'tool_progress', toolName: 'x', message: 'm' } as unknown as AgentEvent);
    expect(rec.snapshot()).toEqual([]);
  });

  it('ignores every non-progress event type', () => {
    const rec = new CronProgressRecorder();
    rec.record({ type: 'text_delta', text: 'hello' });
    rec.record({ type: 'tool_start', toolCallId: '1', toolName: 'x', args: {} });
    rec.record({ type: 'tool_end', toolCallId: '1', toolName: 'x', ok: true, durationMs: 3 });
    rec.record({ type: 'done', text: 'hello', turnCount: 1 });
    expect(rec.snapshot()).toEqual([]);
  });

  it('keeps percent when present and omits it otherwise', () => {
    const rec = new CronProgressRecorder();
    rec.record({
      type: 'tool_progress',
      toolName: 'harvest',
      message: 'halfway',
      percent: 50,
      audience: 'user',
    });
    rec.record(progressEvent('no percent'));
    const snap = rec.snapshot();
    expect(snap[0]?.percent).toBe(50);
    expect(snap[1] && 'percent' in snap[1]).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Retention cap
// ---------------------------------------------------------------------------

describe('CronProgressRecorder retention cap', () => {
  it('keeps everything below the cap', () => {
    const rec = new CronProgressRecorder();
    for (let i = 0; i < PROGRESS_HEAD_LIMIT + PROGRESS_TAIL_LIMIT; i += 1) {
      rec.record(progressEvent(`e${i}`));
    }
    const snap = rec.snapshot();
    expect(snap).toHaveLength(PROGRESS_HEAD_LIMIT + PROGRESS_TAIL_LIMIT);
    expect(snap.some((e) => e.toolName === PROGRESS_ELISION_TOOL)).toBe(false);
  });

  it('keeps head + tail with an elision marker once the cap is exceeded', () => {
    const rec = new CronProgressRecorder();
    const total = 5000;
    for (let i = 0; i < total; i += 1) rec.record(progressEvent(`e${i}`));

    const snap = rec.snapshot();
    // head + marker + tail
    expect(snap).toHaveLength(PROGRESS_HEAD_LIMIT + 1 + PROGRESS_TAIL_LIMIT);

    // First N are the first N emitted.
    expect(snap[0]?.message).toBe('e0');
    expect(snap[PROGRESS_HEAD_LIMIT - 1]?.message).toBe(`e${PROGRESS_HEAD_LIMIT - 1}`);

    // The marker sits between, and names the drop count.
    const marker = snap[PROGRESS_HEAD_LIMIT];
    expect(marker?.toolName).toBe(PROGRESS_ELISION_TOOL);
    const dropped = total - PROGRESS_HEAD_LIMIT - PROGRESS_TAIL_LIMIT;
    expect(marker?.message).toBe(`${dropped} progress events elided`);

    // Last N are the last N emitted — where a stalled run actually got to.
    expect(snap[snap.length - 1]?.message).toBe(`e${total - 1}`);
    expect(snap[PROGRESS_HEAD_LIMIT + 1]?.message).toBe(`e${total - PROGRESS_TAIL_LIMIT}`);
  });

  it('truncates an over-long message', () => {
    const rec = new CronProgressRecorder();
    rec.record(progressEvent('x'.repeat(PROGRESS_MESSAGE_MAX_CHARS + 500)));
    const message = rec.snapshot()[0]?.message ?? '';
    expect(message).toHaveLength(PROGRESS_MESSAGE_MAX_CHARS + '…[truncated]'.length);
    expect(message.endsWith('…[truncated]')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Persistence + read-back
// ---------------------------------------------------------------------------

describe('run progress persistence', () => {
  async function seedJob(scheduler: CronScheduler, prompt: string): Promise<CronJob> {
    return scheduler.createJob({
      name: 'harvest',
      schedule: 'every 1h',
      prompt,
      personalityId: 'default',
      missedRunPolicy: 'skip',
    });
  }

  it('persists recorded progress alongside the run and reads it back', async () => {
    const scheduler = makeScheduler({
      runJob: async (job) => ({
        jobId: job.id,
        ranAt: new Date().toISOString(),
        output: 'harvest complete',
        sessionKey: `cron:${job.id}`,
        progress: [
          { at: '2026-09-08T01:00:00.000Z', toolName: 'harvest', message: 'reddit: start' },
          {
            at: '2026-09-08T01:02:00.000Z',
            toolName: 'harvest',
            message: 'hn: degraded',
            percent: 60,
          },
        ],
      }),
    });
    const job = await seedJob(scheduler, 'harvest everything');
    await scheduler.runJobNow(job.id);

    const runs = await scheduler.listRuns(job.id);
    expect(runs).toHaveLength(1);
    const run = runs[0];
    if (!run) throw new Error('no run');
    expect(run.progressPath).toBeDefined();
    expect(run.progressPath?.endsWith(PROGRESS_SUFFIX)).toBe(true);

    const progress = await scheduler.readRunProgress(run.outputPath);
    expect(progress).toHaveLength(2);
    expect(progress[0]?.message).toBe('reddit: start');
    expect(progress[1]?.percent).toBe(60);

    // The run body itself is untouched by progress capture.
    const body = await scheduler.readRunOutput(run.outputPath);
    expect(body).toBe('# harvest\n\nharvest complete\n');
    expect(body).not.toContain('reddit: start');
  });

  it('writes no sidecar when a run records no progress', async () => {
    const scheduler = makeScheduler({});
    const job = await seedJob(scheduler, 'quiet job');
    await scheduler.runJobNow(job.id);

    const runs = await scheduler.listRuns(job.id);
    expect(runs[0]?.progressPath).toBeUndefined();
    expect(await scheduler.readRunProgress(runs[0]?.outputPath ?? '')).toEqual([]);
  });

  it('reads an OLD run record (no progress field, no sidecar) cleanly', async () => {
    // A run persisted before this feature existed: just the .md file, written
    // straight into storage the way the pre-change scheduler did.
    const scheduler = makeScheduler({});
    const outputPath = join(testDir, 'output', 'legacy-job', '2026-01-01T00-00-00-000Z.md');
    await storage.mkdir(join(testDir, 'output', 'legacy-job'));
    await storage.write(outputPath, '# legacy\n\nold output\n');

    const runs = await scheduler.listRuns('legacy-job');
    expect(runs).toHaveLength(1);
    expect(runs[0]?.progressPath).toBeUndefined();
    await expect(scheduler.readRunProgress(outputPath)).resolves.toEqual([]);
    await expect(scheduler.readRunOutput(outputPath)).resolves.toBe('# legacy\n\nold output\n');
  });

  it('treats a malformed sidecar as no progress rather than a failed read', async () => {
    const scheduler = makeScheduler({});
    const dir = join(testDir, 'output', 'broken-job');
    const outputPath = join(dir, '2026-01-01T00-00-00-000Z.md');
    await storage.mkdir(dir);
    await storage.write(outputPath, '# broken\n\nout\n');
    await storage.write(join(dir, `2026-01-01T00-00-00-000Z${PROGRESS_SUFFIX}`), '{not json');

    await expect(scheduler.readRunProgress(outputPath)).resolves.toEqual([]);
  });

  it('does not list a sidecar as a run of its own', async () => {
    const scheduler = makeScheduler({
      runJob: async (job) => ({
        jobId: job.id,
        ranAt: new Date().toISOString(),
        output: 'done',
        sessionKey: `cron:${job.id}`,
        progress: [{ at: '2026-09-08T01:00:00.000Z', toolName: 't', message: 'm' }],
      }),
    });
    const job = await seedJob(scheduler, 'p');
    await scheduler.runJobNow(job.id);
    expect(await scheduler.listRuns(job.id)).toHaveLength(1);
  });

  it('refuses a progress path outside the output directory', async () => {
    const scheduler = makeScheduler({});
    await expect(scheduler.readRunProgress('/etc/passwd')).rejects.toThrow(
      /outside output directory/,
    );
  });
});

// ---------------------------------------------------------------------------
// The regression that matters: `output` and `[SILENT]` are untouched.
// ---------------------------------------------------------------------------

describe('[SILENT] regression guard', () => {
  it('classifies a [SILENT] run as silent and delivers nothing, even with progress recorded', async () => {
    const delivered: string[] = [];
    const decisions: { action: string; delivered: boolean; output: string }[] = [];
    const SILENT_OUTPUT = '[SILENT] nothing to report';

    const scheduler = makeScheduler({
      runJob: async (job) => ({
        jobId: job.id,
        ranAt: new Date().toISOString(),
        output: SILENT_OUTPUT,
        sessionKey: `cron:${job.id}`,
        progress: Array.from({ length: 15 }, (_, i) => ({
          at: `2026-09-08T01:${String(i).padStart(2, '0')}:00.000Z`,
          toolName: 'harvest',
          message: `stage ${i}`,
        })),
      }),
      deliver: async (_job, output) => {
        delivered.push(output);
      },
      onDecision: (_job, d) => {
        decisions.push({ action: d.action, delivered: d.delivered, output: d.output });
      },
    });

    const job = await scheduler.createJob({
      name: 'quiet',
      schedule: 'every 1h',
      prompt: 'check',
      personalityId: 'default',
      missedRunPolicy: 'skip',
      origin: { platform: 'telegram', chatId: '1' },
    });
    const result = await scheduler.runJobNow(job.id);

    // Nothing was delivered, and the decision is silent.
    expect(delivered).toEqual([]);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.action).toBe('silent');
    expect(decisions[0]?.delivered).toBe(false);

    // `output` is byte-identical to what it would be without the feature —
    // at the decision, on the result, and in the persisted body.
    expect(decisions[0]?.output).toBe(SILENT_OUTPUT);
    expect(result.output).toBe(SILENT_OUTPUT);
    expect(decideEscalation(result.output).action).toBe('silent');

    const runs = await scheduler.listRuns(job.id);
    const body = await scheduler.readRunOutput(runs[0]?.outputPath ?? '');
    expect(body).toBe(`# quiet\n\n${SILENT_OUTPUT}\n`);
    expect(body).not.toContain('stage 0');

    // But the progress IS there, in its own field.
    const progress = await scheduler.readRunProgress(runs[0]?.outputPath ?? '');
    expect(progress).toHaveLength(15);
    expect(progress[14]?.message).toBe('stage 14');
  });

  it('an escalating run delivers output verbatim, with no progress mixed in', async () => {
    const delivered: string[] = [];
    const scheduler = makeScheduler({
      runJob: async (job) => ({
        jobId: job.id,
        ranAt: new Date().toISOString(),
        output: 'Disk at 95%',
        sessionKey: `cron:${job.id}`,
        progress: [{ at: '2026-09-08T01:00:00.000Z', toolName: 'df', message: 'scanning /' }],
      }),
      deliver: async (_job, output) => {
        delivered.push(output);
      },
    });
    const job = await scheduler.createJob({
      name: 'disk',
      schedule: 'every 1h',
      prompt: 'check disk',
      personalityId: 'default',
      missedRunPolicy: 'skip',
      origin: { platform: 'telegram', chatId: '1' },
    });
    await scheduler.runJobNow(job.id);

    expect(delivered).toEqual(['Disk at 95%']);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

describe('parseRunProgress / formatRunProgress', () => {
  it('parses null and non-array bodies as empty', () => {
    expect(parseRunProgress(null)).toEqual([]);
    expect(parseRunProgress('{"a":1}')).toEqual([]);
    expect(parseRunProgress('nope')).toEqual([]);
  });

  it('skips malformed entries but keeps good ones', () => {
    const raw = JSON.stringify([
      { at: 'T1', toolName: 'a', message: 'm1' },
      { at: 'T2' },
      null,
      'string',
      { at: 'T3', message: 'm3' },
    ]);
    const out = parseRunProgress(raw);
    expect(out).toEqual([
      { at: 'T1', toolName: 'a', message: 'm1' },
      { at: 'T3', toolName: 'unknown', message: 'm3' },
    ]);
  });

  it('renders nothing for an empty list', () => {
    expect(formatRunProgress([])).toBe('');
  });

  it('renders a Progress section with timestamps and percents', () => {
    const out = formatRunProgress([
      { at: 'T1', toolName: 'harvest', message: 'reddit' },
      { at: 'T2', toolName: 'harvest', message: 'hn', percent: 60 },
    ]);
    expect(out).toBe('## Progress\n\n- T1 harvest: reddit\n- T2 harvest (60%): hn');
  });
});
