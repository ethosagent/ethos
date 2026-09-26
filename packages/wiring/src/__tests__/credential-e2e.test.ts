// openclaw-9.5 item 1 — end to end, the secret goes to the vault and nowhere
// else. A real AgentLoop with a real SQLite session store, a real PluginLoader
// over a real file vault, a real file clarify store and real SQLite
// observability, all in a temp state dir:
//
//   turn 1 (credentialPrompt) → credential_required, refused pre-turn
//   surface: masked value → PluginLoader.setCredential (the one writer, D15)
//   turn 2 (resubmitted pendingUserMessage) → runs and answers
//
// Then every byte in the state dir is searched: the value may appear only
// under `secrets/` (FileSecretsResolver stores it there), never in
// `sessions.db` (+WAL), `clarify/`, `observability.db` (+WAL), and never in an
// AgentEvent from either turn.

import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import {
  AgentLoop,
  ClarifyBridge,
  DefaultHookRegistry,
  DefaultLLMProviderRegistry,
  DefaultMemoryProviderRegistry,
  DefaultPersonalityRegistry,
  DefaultToolRegistry,
  FileClarifyStore,
} from '@ethosagent/core';
import {
  BlobStore,
  ObservabilityService,
  SQLiteObservabilityStore,
} from '@ethosagent/observability-sqlite';
import { PluginLoader } from '@ethosagent/plugin-loader';
import type { PluginRegistries } from '@ethosagent/plugin-sdk';
import { SQLiteSessionStore } from '@ethosagent/session-sqlite';
import { FileSecretsResolver, FsStorage } from '@ethosagent/storage-fs';
import type { AgentEvent, CompletionChunk, ContextInjector, LLMProvider } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestSafety } from '../../../core/src/__tests__/helpers/test-safety';
import { buildCredentialCheck } from '../credential-check';
import { EthosObservability } from '../observability/ethos-observability';

const SECRET = 'sk-live-E2E-NEVER-LEAK-7f3a9c';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ethos-cred-e2e-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function allFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const p = join(root, entry.name);
    if (entry.isDirectory()) out.push(...(await allFiles(p)));
    else out.push(p);
  }
  return out;
}

function echoLLM(): LLMProvider {
  return {
    name: 'scripted',
    model: 'mock-model',
    maxContextTokens: 200_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(): AsyncIterable<CompletionChunk> {
      yield { type: 'text_delta', text: 'Sunny in Lisbon.' };
      yield { type: 'done', finishReason: 'end_turn' };
    },
    async countTokens() {
      return 1;
    },
  };
}

async function drain(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const ev of gen) events.push(ev);
  return events;
}

describe('masked credential request, end to end', () => {
  it('the value reaches the vault and no session row, clarify file, observability record or event', async () => {
    const storage = new FsStorage();

    // A tiny plugin declaring one required secret.
    const pluginDir = join(dir, 'plugins', 'weather');
    await storage.mkdir(pluginDir);
    await storage.write(
      join(pluginDir, 'package.json'),
      JSON.stringify({
        name: 'weather',
        version: '1.0.0',
        main: 'index.js',
        ethos: {
          type: 'plugin',
          pluginContractMajor: 4,
          credentials: [
            { key: 'API_KEY', label: 'Weather API key', type: 'secret', required: true },
          ],
        },
      }),
    );
    await storage.write(join(pluginDir, 'index.js'), 'export async function activate() {}\n');

    const registries: PluginRegistries = {
      tools: new DefaultToolRegistry(),
      hooks: new DefaultHookRegistry(),
      injectors: [] as ContextInjector[],
      injectorPluginIds: new Map<ContextInjector, string>(),
      personalities: new DefaultPersonalityRegistry(),
      llmProviders: new DefaultLLMProviderRegistry(),
      memoryProviders: new DefaultMemoryProviderRegistry(),
    };
    const secrets = new FileSecretsResolver({ dir: join(dir, 'secrets'), storage });
    const loader = new PluginLoader(registries, { storage, secrets, dataDir: dir });
    await loader.loadFromPluginDir(pluginDir, 'weather');
    expect(loader.isLoaded('weather')).toBe(true);

    const obsStore = new SQLiteObservabilityStore(join(dir, 'observability.db'));
    const observability = new EthosObservability(
      new ObservabilityService(obsStore, new BlobStore(join(dir, 'blobs'), storage)),
    );
    const session = new SQLiteSessionStore(join(dir, 'sessions.db'));
    const clarifyBridge = new ClarifyBridge(new FileClarifyStore(storage, join(dir, 'clarify')), {
      reconcilePollMs: 0,
    });

    const personalities = new DefaultPersonalityRegistry();
    personalities.define({ id: 'ops', name: 'Ops', plugins: ['weather'] });
    personalities.setDefault('ops');

    const loop = new AgentLoop({
      llm: echoLLM(),
      tools: registries.tools,
      personalities,
      session,
      clarifyBridge,
      observability,
      safety: createTestSafety(),
      dataDir: dir,
      credentialCheck: buildCredentialCheck({ pluginLoader: loader, observability }),
    });

    try {
      const sessionKey = 'cli:e2e';
      const first = await drain(
        loop.run('forecast for Lisbon?', { sessionKey, credentialPrompt: true }),
      );
      const req = first.find((e) => e.type === 'credential_required');
      expect(req).toMatchObject({ pluginId: 'weather', credentialKey: 'API_KEY' });
      if (req?.type !== 'credential_required') throw new Error('no credential_required');

      // What every surface does with the masked value: the one writer (D15).
      // The CLI's own prompt around it is pinned in
      // apps/ethos/src/__tests__/credential-prompt.test.ts.
      await loader.setCredential(req.pluginId, req.credentialKey, SECRET);

      const second = await drain(
        loop.run(req.pendingUserMessage, { sessionKey, credentialPrompt: true }),
      );
      expect(second.some((e) => e.type === 'credential_required')).toBe(false);
      expect(second.at(-1)).toMatchObject({ type: 'done', text: 'Sunny in Lisbon.' });

      // No AgentEvent from either turn carries the value.
      expect(JSON.stringify([...first, ...second])).not.toContain(SECRET);
      // The vault holds it.
      expect(await loader.getCredentialValue('weather', 'API_KEY')).toBe(SECRET);
    } finally {
      observability.flush();
      session.close();
      obsStore.close();
    }

    // Every byte on disk: the value lives under secrets/ and nowhere else.
    const files = await allFiles(dir);
    const holding: string[] = [];
    for (const f of files) {
      if ((await readFile(f)).includes(SECRET)) holding.push(relative(dir, f));
    }
    expect(holding).toEqual([join('secrets', 'plugins', 'weather', 'API_KEY')]);
    // The stores this test claims to have searched really were written.
    const names = files.map((f) => relative(dir, f));
    expect(names.some((n) => n.startsWith('sessions.db'))).toBe(true);
    expect(names.some((n) => n.startsWith('observability.db'))).toBe(true);
  });
});
