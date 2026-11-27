// plan initiative-engine L2 — the run registry is built with capability backends,
// so `read_file` / `search_files` receive a `scopedFs` bounded to the run's source
// paths (readOnlyCapabilityBackends). Without backends the registry fails closed.

import { InMemoryStorage } from '@ethosagent/storage-fs';
import type {
  InitiativeLedgerPort,
  MemoryProvider,
  PersonalityConfig,
  SessionStore,
  ToolContext,
} from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { buildReadOnlyRegistry, defaultInitiativeToolFactories } from '../initiatives';

const personality: PersonalityConfig = {
  id: 'open',
  name: 'open',
  toolset: ['read_file', 'search_files'],
};

function ctx(): ToolContext {
  return {
    sessionId: 's',
    sessionKey: 'initiative:i1:w',
    platform: 'cli',
    workingDir: '/tmp',
    currentTurn: 1,
    messageCount: 1,
    abortSignal: new AbortController().signal,
    emit: () => {},
    resultBudgetChars: 80_000,
  } as unknown as ToolContext;
}

async function build() {
  const storage = new InMemoryStorage();
  await storage.mkdir('/src');
  await storage.mkdir('/other');
  await storage.write('/src/a.txt', 'inside');
  await storage.mkdir('/src/state');
  await storage.write('/src/state/keys.json', '{"k":"secret"}');
  await storage.write('/other/b.txt', 'outside');
  const registry = buildReadOnlyRegistry({
    personality,
    ledger: {} as InitiativeLedgerPort,
    initiativeId: 'i1',
    sourcePaths: ['/src/'],
    storage,
    dataDir: '/src/state',
    factories: defaultInitiativeToolFactories({
      env: {},
      toolsConfig: () => undefined,
      memory: {} as MemoryProvider,
      session: {} as SessionStore,
    }),
  });
  return registry;
}

describe('initiative run registry backends', () => {
  it('read_file gets a scopedFs bounded to the source paths', async () => {
    const registry = await build();
    const [inside] = await registry.executeParallel(
      [{ toolCallId: 'c1', name: 'read_file', args: { path: '/src/a.txt' } }],
      ctx(),
    );
    expect(inside?.result.ok).toBe(true);
    expect(inside?.result.ok && inside.result.value).toContain('inside');

    const [outside] = await registry.executeParallel(
      [{ toolCallId: 'c2', name: 'read_file', args: { path: '/other/b.txt' } }],
      ctx(),
    );
    expect(outside?.result.ok).toBe(false);
  });

  it('refuses the state dir even when a source root covers its parent', async () => {
    const registry = await build();
    const [res] = await registry.executeParallel(
      [{ toolCallId: 'c3', name: 'read_file', args: { path: '/src/state/keys.json' } }],
      ctx(),
    );
    expect(res?.result.ok).toBe(false);
  });

  it('registers no write tool, so nothing can write through the run', async () => {
    const registry = await build();
    expect(registry.get('write_file')).toBeUndefined();
  });
});
