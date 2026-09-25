// `execution.docker.image` survives a loop that also configures a Pi runner.
//
// The defect this guards: `ethos serve` refused every docker-posture `terminal`
// call with `MissingDockerImageError` while `ethos doctor` and `ethos
// personality show` printed the configured image. The execution-backend
// registry memoises by NAME and keeps whichever ctx resolved first. The routing
// (`createExecutionRouting`) resolves docker lazily when the default
// personality is not at the docker posture, so `buildAgentLoop`'s Pi runner
// (`background.pi.image`) got there first — with its own config and no
// `images` — and every exec tool then ran on that instance. Driven through the
// REAL composition root (`createAgentLoop`, serve's profile), with the docker
// backend class subclassed only to record the config it was constructed with:
// nothing here talks to a Docker daemon.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExecutionBackendConfig } from '@ethosagent/types';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createAgentLoop, type WiringConfig } from '../index';

vi.mock('@ethosagent/execution-docker', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ethosagent/execution-docker')>();
  class RecordingDockerBackend extends actual.DockerExecutionBackend {
    readonly constructedWith: ExecutionBackendConfig;
    constructor(ctx: ConstructorParameters<typeof actual.DockerExecutionBackend>[0]) {
      super(ctx);
      this.constructedWith = ctx.config;
    }
  }
  return { ...actual, DockerExecutionBackend: RecordingDockerBackend };
});

const IMAGE = `mirror.gcr.io/library/node@sha256:${'c'.repeat(64)}`;
const PI_IMAGE = `localhost:5555/ethos-pi@sha256:${'d'.repeat(64)}`;

let home: string;
let dataDir: string;
const prevEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'ethos-docker-image-serve-'));
  dataDir = join(home, '.ethos');
  const trader = join(dataDir, 'personalities', 'trader');
  mkdirSync(trader, { recursive: true });
  writeFileSync(join(trader, 'config.yaml'), 'name: Trader\ndescription: docker posture\n');
  writeFileSync(join(trader, 'toolset.yaml'), '- terminal\n');
  writeFileSync(join(trader, 'SOUL.md'), 'I trade.\n');
  for (const key of ['HOME', 'ETHOS_STATE_DIR'] as const) prevEnv[key] = process.env[key];
  process.env.HOME = home;
  process.env.ETHOS_STATE_DIR = dataDir;
});

afterAll(() => {
  for (const [key, value] of Object.entries(prevEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true });
});

/** serve's shape: a non-exec default personality, a Pi runner, a sandbox image. */
function serveConfig(): WiringConfig {
  return {
    provider: 'ollama',
    model: 'offline-test',
    baseUrl: 'http://127.0.0.1:9',
    apiKey: 'sk-dummy',
    personality: 'researcher',
    background: { enabled: true, pi: { image: PI_IMAGE } },
    execution: { docker: { image: IMAGE } },
  };
}

describe('execution.docker.image under a serve-shaped loop with a Pi runner', () => {
  it('the docker backend the exec tools share is built with the configured image', async () => {
    const runtime = await createAgentLoop(serveConfig(), {
      dataDir,
      workingDir: home,
      profile: 'web',
    });
    try {
      // The Pi runner is registered, so the loop took the path that resolved
      // docker before any exec tool did.
      expect(runtime.jobRunners?.list()).toContain('pi');
      // The ONE registry instance — what the routing's `SessionManager` wraps
      // for every docker-posture `terminal` / `run_code` / `process_*` call.
      const backend = runtime.executionBackends.get('docker') as
        | { constructedWith?: ExecutionBackendConfig }
        | undefined;
      expect(backend?.constructedWith?.images).toEqual({ default: IMAGE });
    } finally {
      await runtime.dispose();
    }
  });
});
