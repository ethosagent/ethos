import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DefaultToolRegistry } from '@ethosagent/core';
import { SQLiteSessionStore } from '@ethosagent/session-sqlite';
import { FsStorage } from '@ethosagent/storage-fs';
import type { Tool } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWebApi, WebTokenRepository } from '../../index';
import {
  makeStubAgentLoop,
  makeStubMemoryProvider,
  makeStubPersonalityRegistry,
} from '../test-helpers';

// A tool may need a credential it does not bind itself — quora_search,
// linkedin_search and reddit_web_search read the personality's `web_search`
// binding (plan/completed/social-search-tools.md D3a). The `info` field kind is
// how they disclose that where an operator looks for credentials.
//
// The risk this pins is silent stripping: `toolSettings.schemas` validates its
// output against the contract's discriminated union, so an `info` field that
// the wire schema does not know about fails the whole response rather than
// arriving degraded. This drives the REAL router over HTTP — registration →
// ToolSettingsService.schemas() → contract validation → JSON — rather than
// calling the service and asserting on its return value.
//
// The tool is a stand-in (web-api does not depend on
// @ethosagent/tools-social-search); the three real tools' own declarations are
// pinned in packages/wiring/src/__tests__/social-search-tools.test.ts.
const disclosureStub: Tool = {
  name: 'site_search_stub',
  description: 'stub',
  schema: {},
  capabilities: {},
  settingsSchema: {
    fields: [
      {
        kind: 'info',
        label: 'Web search credential',
        text: 'Uses this personality’s web_search binding; no key of its own.',
      },
    ],
  },
  async execute() {
    return { ok: true, value: '' };
  },
};

describe('toolSettings.schemas RPC — the info field kind', () => {
  let dataDir: string;
  let store: SQLiteSessionStore;
  let app: ReturnType<typeof createWebApi>['app'];
  let cookie: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'ethos-tool-settings-info-'));
    await mkdir(join(dataDir, 'personalities'), { recursive: true });

    const toolRegistry = new DefaultToolRegistry();
    toolRegistry.register(disclosureStub);

    store = new SQLiteSessionStore(':memory:');
    app = createWebApi({
      dataDir,
      sessionStore: store,
      memoryProvider: makeStubMemoryProvider(),
      agentLoop: makeStubAgentLoop(),
      personalities: makeStubPersonalityRegistry([], dataDir),
      chatDefaults: { model: 'claude-test', provider: 'anthropic' },
      toolRegistry,
    }).app;

    const tokens = new WebTokenRepository({ dataDir, storage: new FsStorage() });
    const token = await tokens.getOrCreate();
    const exchange = await app.request(`/auth/exchange?t=${token}`, {
      headers: { origin: 'http://localhost:3000' },
    });
    cookie = (exchange.headers.get('set-cookie') ?? '').split(/;\s*/)[0] ?? '';
  });

  afterEach(async () => {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('survives the wire: label and text arrive intact, with no settings key', async () => {
    const res = await app.request('/rpc/toolSettings/schemas', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie,
        origin: 'http://localhost:3000',
      },
      body: JSON.stringify({ json: {} }),
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      json: { tools: Array<{ name: string; settingsSchema: { fields: unknown[] } }> };
    };
    const tool = body.json.tools.find((t) => t.name === 'site_search_stub');
    if (!tool) throw new Error('expected the stub tool on the wire');
    expect(tool.settingsSchema.fields).toEqual([
      {
        kind: 'info',
        label: 'Web search credential',
        text: 'Uses this personality’s web_search binding; no key of its own.',
      },
    ]);
    // No `key`: an info row cannot index the settings map, so nothing the
    // operator sees here can be written back.
    expect(tool.settingsSchema.fields[0]).not.toHaveProperty('key');
  });
});
