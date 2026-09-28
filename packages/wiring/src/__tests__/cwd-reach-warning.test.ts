import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger, PersonalityConfig } from '@ethosagent/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cwdReachWarning } from '../cwd-reach-warning';
import { createAgentLoop } from '../index';

const HOME = '/home/op';
const bare: PersonalityConfig = { id: 'bare', name: 'Bare' };
const pinned: PersonalityConfig = {
  id: 'pinned',
  name: 'Pinned',
  fs_reach: { workdir: '/srv/app' },
};

describe('UBP-047 — boot warns when cwd is / or $HOME with no declared workdir', () => {
  it('warns at $HOME, naming the personality', () => {
    const msg = cwdReachWarning([bare, pinned], HOME, HOME);
    expect(msg).toContain('process cwd is /home/op');
    expect(msg).toContain('bare declares no workdir');
    expect(msg).not.toContain('pinned');
  });

  it('warns at /', () => {
    expect(cwdReachWarning([bare], '/', HOME)).toContain('process cwd is /');
  });

  it('is silent in a project directory', () => {
    expect(cwdReachWarning([bare], '/home/op/code/app', HOME)).toBeUndefined();
  });

  it('is silent when every personality declares a workdir or both lists', () => {
    const lists: PersonalityConfig = {
      id: 'lists',
      name: 'Lists',
      fs_reach: { read: ['/data/'], write: ['/data/out/'] },
    };
    expect(cwdReachWarning([pinned, lists], HOME, HOME)).toBeUndefined();
  });
});

describe('UBP-047 — createAgentLoop logs the warning at boot', () => {
  let home: string;
  const prev: Record<string, string | undefined> = {};

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'ethos-cwd-warn-'));
    mkdirSync(join(home, '.ethos'), { recursive: true });
    for (const key of ['HOME', 'ETHOS_STATE_DIR'] as const) prev[key] = process.env[key];
    process.env.HOME = home;
    process.env.ETHOS_STATE_DIR = join(home, '.ethos');
  });

  afterAll(() => {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(home, { recursive: true, force: true });
  });

  function capture(): { logger: Logger; warnings: string[] } {
    const warnings: string[] = [];
    const logger: Logger = {
      debug: () => {},
      info: () => {},
      warn: (message) => warnings.push(message),
      error: () => {},
      child: () => logger,
    };
    return { logger, warnings };
  }

  async function boot(workingDir: string): Promise<string[]> {
    const { logger, warnings } = capture();
    const runtime = await createAgentLoop(
      { provider: 'anthropic', model: 'claude-sonnet-4-5', apiKey: 'sk-test' },
      { dataDir: join(home, '.ethos'), workingDir, profile: 'cli', disableDocker: true, logger },
    );
    await runtime.dispose();
    return warnings.filter((w) => w.startsWith('fs_reach: process cwd is'));
  }

  it('cwd = $HOME → one warning', async () => {
    expect(await boot(home)).toHaveLength(1);
  });

  it('cwd = a project directory → none', async () => {
    const project = join(home, 'code');
    mkdirSync(project, { recursive: true });
    expect(await boot(project)).toHaveLength(0);
  });
});
