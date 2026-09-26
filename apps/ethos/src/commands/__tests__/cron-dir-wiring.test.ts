// Every host resolves the cron store from the state dir.
//
// `CronScheduler` used to default `cronDir` to `homedir()/.ethos/cron` and
// ignore `ETHOS_STATE_DIR`, so a process pointed at an isolated state dir still
// read and wrote the real `~/.ethos/cron/jobs.json`. `cronDir` and
// `scriptsDir` are now required inputs with no default, and every host passes
// `ethosCronDir()` / `ethosScriptsDir()` from `@ethosagent/config`.
//
// Two halves, the same idiom as `gateway-unattended-gate-wiring.test.ts`:
//  - runtime: a scheduler built the way the hosts build it writes `jobs.json`
//    under ETHOS_STATE_DIR and nothing under HOME, and `ethos status` counts
//    that same file;
//  - source text: `ethos cron`, `ethos gateway start`, `ethos boot` and
//    `ethos serve` each pass the same two resolvers. Those commands boot whole
//    processes and cannot be invoked from a unit test.

import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ethosCronDir, ethosScriptsDir } from '@ethosagent/config';
import { CronScheduler } from '@ethosagent/cron';
import { FsStorage } from '@ethosagent/storage-fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { countCronJobs } from '../status';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..', '..');

const HOSTS = [
  'apps/ethos/src/commands/cron.ts',
  'apps/ethos/src/commands/gateway.ts',
  'apps/ethos/src/commands/boot.ts',
  'apps/ethos/src/commands/serve.ts',
] as const;

/** The object literal handed to each `new CronScheduler(` in `src`. */
function schedulerConfigs(src: string): string[] {
  const out: string[] = [];
  let at = src.indexOf('new CronScheduler({');
  while (at !== -1) {
    // Hosts close the literal with a two-space-indented `});`.
    const end = src.indexOf('\n  });', at);
    out.push(src.slice(at, end === -1 ? undefined : end));
    at = src.indexOf('new CronScheduler({', at + 1);
  }
  return out;
}

describe('cron directory — resolved from the state dir', () => {
  let scratch: string;
  let prevStateDir: string | undefined;
  let prevHome: string | undefined;

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'ethos-cron-dir-'));
    prevStateDir = process.env.ETHOS_STATE_DIR;
    prevHome = process.env.HOME;
    process.env.HOME = join(scratch, 'home');
    process.env.ETHOS_STATE_DIR = join(scratch, 'state');
  });

  afterEach(async () => {
    if (prevStateDir === undefined) delete process.env.ETHOS_STATE_DIR;
    else process.env.ETHOS_STATE_DIR = prevStateDir;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    await rm(scratch, { recursive: true, force: true });
  });

  it('a scheduler built like the hosts build it writes jobs.json under ETHOS_STATE_DIR', async () => {
    const scheduler = new CronScheduler({
      storage: new FsStorage(),
      cronDir: ethosCronDir(),
      scriptsDir: ethosScriptsDir(),
      tickIntervalMs: 999_999,
      runJob: async (job) => ({
        jobId: job.id,
        ranAt: new Date().toISOString(),
        output: '',
        sessionKey: `cron:${job.id}`,
      }),
    });
    await scheduler.createJob({
      name: 'isolated',
      schedule: 'every 5m',
      prompt: 'p',
      personalityId: 'researcher',
      missedRunPolicy: 'skip',
    });

    const jobsPath = join(scratch, 'state', 'cron', 'jobs.json');
    const jobs: unknown = JSON.parse(await readFile(jobsPath, 'utf-8'));
    expect(Array.isArray(jobs) && jobs.length).toBe(1);
    // Nothing leaked into the home directory's `.ethos`.
    expect(existsSync(join(scratch, 'home', '.ethos'))).toBe(false);
    expect(await readdir(scratch)).toEqual(['state']);

    // `ethos status` reads the file the scheduler wrote.
    expect(countCronJobs()).toEqual({ status: 'ok', total: 1, enabled: 1 });
  });

  it.each(HOSTS)(
    '%s passes ethosCronDir() and ethosScriptsDir() to every CronScheduler',
    async (host) => {
      const src = await readFile(join(ROOT, host), 'utf8');
      const configs = schedulerConfigs(src);
      expect(configs.length).toBeGreaterThan(0);
      for (const config of configs) {
        expect(config).toContain('cronDir: ethosCronDir(),');
        expect(config).toContain('scriptsDir: ethosScriptsDir(),');
      }
    },
  );

  it('the CLI and the gateway resolve the same cron directory', async () => {
    const cli = schedulerConfigs(await readFile(join(ROOT, HOSTS[0]), 'utf8'));
    const gateway = schedulerConfigs(await readFile(join(ROOT, HOSTS[1]), 'utf8'));
    const cronDirLine = (c: string | undefined) =>
      c?.split('\n').find((l) => l.trim().startsWith('cronDir:'));
    expect(cronDirLine(cli[0])).toBeDefined();
    expect(cronDirLine(cli[0])).toBe(cronDirLine(gateway[0]));
  });

  it('webhook prefilters resolve scripts from the state dir too', async () => {
    for (const host of ['apps/ethos/src/commands/gateway.ts', 'apps/ethos/src/commands/boot.ts']) {
      const src = await readFile(join(ROOT, host), 'utf8');
      const at = src.indexOf('runScriptFile(\n');
      expect(at).toBeGreaterThan(-1);
      expect(src.slice(at, src.indexOf('    );', at))).toContain('scriptsDir: ethosScriptsDir(),');
    }
  });
});
