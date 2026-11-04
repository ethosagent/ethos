// Shared fixtures for the keyless first-run setup tests: a throwaway
// ETHOS_STATE_DIR, a real FsStorage over it, an in-memory vault and a funnel
// recorder, plus a scripted prompt and a fake Ollama `fetch`.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FsStorage, InMemorySecretsResolver } from '@ethosagent/storage-fs';
import { vi } from 'vitest';

export interface Harness {
  root: string;
  dataDir: string;
  storage: FsStorage;
  secrets: InMemorySecretsResolver;
  funnel: { setups: unknown[]; firstLaunches: number };
}

export const harness: Harness = {
  root: '',
  dataDir: '',
  storage: new FsStorage(),
  secrets: new InMemorySecretsResolver(),
  funnel: { setups: [], firstLaunches: 0 },
};

export async function beforeEachHarness(): Promise<void> {
  harness.root = await mkdtemp(join(tmpdir(), 'ethos-setup-keyless-'));
  harness.dataDir = join(harness.root, '.ethos');
  harness.storage = new FsStorage();
  harness.secrets = new InMemorySecretsResolver();
  harness.funnel = { setups: [], firstLaunches: 0 };
  process.env.ETHOS_STATE_DIR = harness.dataDir;
}

export async function afterEachHarness(): Promise<void> {
  delete process.env.ETHOS_STATE_DIR;
  await rm(harness.root, { recursive: true, force: true });
  vi.restoreAllMocks();
}

/** The `../../wiring` mock factory body. */
export function wiringMock() {
  return {
    getStorage: () => harness.storage,
    getSecretsResolver: async () => harness.secrets,
    getFunnelTracker: () => ({
      recordSetupCompleted: async (o: unknown) => {
        harness.funnel.setups.push(o);
      },
      recordFirstLaunch: async () => {
        harness.funnel.firstLaunches += 1;
      },
    }),
  };
}

/** Answers consumed in order; records every question. */
export function scripted(answers: string[]) {
  const asked: string[] = [];
  const queue = [...answers];
  return {
    asked,
    ask: async (q: string) => {
      asked.push(q);
      return queue.shift() ?? '';
    },
  };
}

/** A fake Ollama: `127.0.0.1:11434` serves `models`; every other host refuses. */
export function fakeOllamaFetch(models: string[], servedWindow?: number): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const u = new URL(url);
    if (u.host !== '127.0.0.1:11434') throw new Error('ECONNREFUSED');
    if (u.pathname.endsWith('/api/ps')) {
      const loaded =
        servedWindow === undefined
          ? []
          : models.map((name) => ({ name, model: name, context_length: servedWindow }));
      return new Response(JSON.stringify({ models: loaded }));
    }
    return new Response(JSON.stringify({ data: models.map((id) => ({ id })) }), { status: 200 });
  }) as unknown as typeof fetch;
}
