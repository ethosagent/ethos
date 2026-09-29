// `ethos cron` and a job's `activeHours` (plan personality-presence-and-initiative §6).
//
// Two halves, the same idiom as `cron-dir-wiring.test.ts`:
//  - runtime: `ethos cron create/update --active-hours` sets, moves and clears
//    the window, and `list`/`show` (text and `--json`) display it;
//  - source text: no host hands `CronScheduler` a zone of its own. A window is
//    read on the host's clock, the clock croner reads the schedule on
//    (`CronScheduler.outsideActiveHours`); a host that passed
//    `notifications.timezone` would split the two.

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EthosConfig } from '@ethosagent/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCronCommand } from '../cron';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..', '..');
const CONFIG = { personality: 'default' } as EthosConfig;

let scratch: string;
let prevStateDir: string | undefined;
let out: string[];

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'ethos-cron-active-hours-'));
  prevStateDir = process.env.ETHOS_STATE_DIR;
  process.env.ETHOS_STATE_DIR = scratch;
  out = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    out.push(args.map(String).join(' '));
  });
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    out.push(String(chunk));
    return true;
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (prevStateDir === undefined) delete process.env.ETHOS_STATE_DIR;
  else process.env.ETHOS_STATE_DIR = prevStateDir;
  await rm(scratch, { recursive: true, force: true });
});

async function storedJob(id: string): Promise<Record<string, unknown> | undefined> {
  const raw = await readFile(join(scratch, 'cron', 'jobs.json'), 'utf8').catch(() => '[]');
  const jobs: Array<Record<string, unknown>> = JSON.parse(raw);
  return jobs.find((j) => j.id === id);
}

const CREATE = ['--name', 'Check in', '--schedule', 'every 2h', '--prompt', 'Anything?'];

describe('ethos cron --active-hours', () => {
  it('create stores the window', async () => {
    await runCronCommand('create', [...CREATE, '--active-hours', '09:00-21:00'], CONFIG);
    expect((await storedJob('check-in'))?.activeHours).toBe('09:00-21:00');
  });

  it('create refuses a malformed window and a one-shot schedule, and creates nothing', async () => {
    await runCronCommand('create', [...CREATE, '--active-hours', '9am-5pm'], CONFIG);
    expect(out.join('\n')).toContain('Invalid activeHours');
    await runCronCommand(
      'create',
      ['--name', 'Once', '--schedule', '30m', '--prompt', 'p', '--active-hours', '09:00-21:00'],
      CONFIG,
    );
    expect(out.join('\n')).toContain('one-shot');
    expect(await storedJob('check-in')).toBeUndefined();
    expect(await storedJob('once')).toBeUndefined();
  });

  it('update moves the window and "off" clears it', async () => {
    await runCronCommand('create', CREATE, CONFIG);
    await runCronCommand('update', ['check-in', '--active-hours', '22:00-06:00'], CONFIG);
    expect((await storedJob('check-in'))?.activeHours).toBe('22:00-06:00');
    await runCronCommand('update', ['check-in', '--active-hours', 'off'], CONFIG);
    expect(await storedJob('check-in')).not.toHaveProperty('activeHours');
  });

  it('list and show display the window, in text and --json', async () => {
    await runCronCommand('create', [...CREATE, '--active-hours', '09:00-21:00'], CONFIG);

    out = [];
    await runCronCommand('list', [], CONFIG);
    expect(out.join('\n')).toMatch(/Active hours\s*: 09:00-21:00/);
    out = [];
    await runCronCommand('show', ['check-in'], CONFIG);
    expect(out.join('\n')).toMatch(/Active hours\s*: 09:00-21:00/);

    out = [];
    await runCronCommand('list', ['--json'], CONFIG);
    expect(JSON.parse(out.join(''))[0].activeHours).toBe('09:00-21:00');
    out = [];
    await runCronCommand('show', ['check-in', '--json'], CONFIG);
    expect(JSON.parse(out.join('')).activeHours).toBe('09:00-21:00');
  });

  it('--json reports activeHours null when the job has none', async () => {
    await runCronCommand('create', CREATE, CONFIG);
    out = [];
    await runCronCommand('show', ['check-in', '--json'], CONFIG);
    expect(JSON.parse(out.join('')).activeHours).toBeNull();
  });
});

describe('activeHours clock — hosts leave the scheduler on the host zone', () => {
  it.each([
    'apps/ethos/src/commands/cron.ts',
    'apps/ethos/src/commands/gateway.ts',
    'apps/ethos/src/commands/boot.ts',
    'apps/ethos/src/commands/serve.ts',
  ])('%s passes no timeZone to CronScheduler', async (host) => {
    const src = await readFile(join(ROOT, host), 'utf8');
    let at = src.indexOf('new CronScheduler({');
    expect(at).toBeGreaterThan(-1);
    while (at !== -1) {
      const end = src.indexOf('\n  });', at);
      expect(src.slice(at, end === -1 ? undefined : end)).not.toMatch(/\btimeZone\b/);
      at = src.indexOf('new CronScheduler({', at + 1);
    }
  });
});
