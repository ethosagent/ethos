import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createPersonalityRegistry } from '@ethosagent/personalities';
import { FsStorage } from '@ethosagent/storage-fs';
import { createWebApi } from '@ethosagent/web-api';
import type { WiringConfig } from '@ethosagent/wiring';
import {
  createAgentLoop,
  createDangerPredicate,
  createMemoryProvider,
  createSessionStore,
  IdentityMap,
} from '@ethosagent/wiring';
import { serve as honoServe } from '@hono/node-server';
import { getKeychainValue } from './keychain';
import { store } from './store';

type ServerHandle = ReturnType<typeof honoServe>;

let serverHandle: ServerHandle | null = null;

function getDataDir(): string {
  return store.get('dataDir') ?? join(homedir(), '.ethos');
}

export async function startServer(port: number): Promise<void> {
  if (serverHandle) return;

  const dataDir = getDataDir();

  const provider = (store.get('provider') as string) ?? 'anthropic';
  const model = (store.get('model') as string) ?? 'claude-sonnet-4-20250514';
  const baseUrl = store.get('baseUrl') as string | undefined;

  // Prefer keychain; fall back to secrets file (written by the onboarding handler)
  const apiKey = (await getKeychainValue('api-key')) ?? '';

  const wiringConfig: WiringConfig = {
    provider,
    model,
    apiKey,
    personality: (store.get('personalityId') as string | undefined) ?? 'operator',
    memory: store.get('memory') ?? 'markdown',
    ...(baseUrl ? { baseUrl } : {}),
  };

  const { loop, toolRegistry } = await createAgentLoop(wiringConfig, {
    dataDir,
    profile: 'web',
    disableDocker: true,
  });

  const session = createSessionStore({ dataDir });

  const personalities = await createPersonalityRegistry({ userPersonalitiesDir: dataDir });

  // Load built-in personalities from the bundled data directory.
  // import.meta.dirname inside loadBuiltins() points to the bundled output dir
  // after electron-vite, so we resolve the data dir ourselves.
  const builtinPersonalitiesDir = (() => {
    const candidates = [
      join(__dirname, '..', '..', 'extensions', 'personalities', 'data'),
      join(__dirname, '..', '..', '..', '..', 'extensions', 'personalities', 'data'),
    ];
    for (const c of candidates) {
      if (existsSync(c)) return c;
    }
    return undefined;
  })();
  if (builtinPersonalitiesDir) {
    await personalities.loadFromDirectory(builtinPersonalitiesDir);
  }

  await personalities.loadFromDirectory(join(dataDir, 'personalities'));

  const identityMap = new IdentityMap({ storage: new FsStorage(), dataDir });
  await identityMap.resolve('desktop', 'desktop', 'Desktop');

  const skillsCatalogDir = (() => {
    const candidates = [
      join(__dirname, '..', '..', 'skills'),
      join(__dirname, '..', '..', '..', '..', 'skills'),
    ];
    for (const c of candidates) {
      if (existsSync(c)) return c;
    }
    return undefined;
  })();

  const { app: webApp } = createWebApi({
    dataDir,
    sessionStore: session,
    memoryProvider: createMemoryProvider({ dataDir }),
    identityMap,
    agentLoop: loop,
    personalities,
    chatDefaults: { model, provider },
    dangerPredicate: createDangerPredicate(),
    toolRegistry,
    ...(skillsCatalogDir ? { catalogDir: skillsCatalogDir } : {}),
  });

  await new Promise<void>((resolve, reject) => {
    const s = honoServe({ fetch: webApp.fetch, port, hostname: '127.0.0.1' }, () => {
      serverHandle = s;
      resolve();
    });
    s.once('error', reject);
  });

  console.log(`[ethos-backend] in-process server listening on http://127.0.0.1:${port}`);
}

export async function stopServer(): Promise<void> {
  if (!serverHandle) return;
  const s = serverHandle;
  serverHandle = null;
  await new Promise<void>((resolve) => s.close(() => resolve()));
}
