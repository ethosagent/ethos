// The mesh tools (`route_to_agent`, `dispatch_team`, `broadcast_to_agents`,
// extensions/tools-delegation/src/index.ts) against a REAL `AcpServer` on
// localhost, reached through the REAL `safeFetch` floor with a personality that
// sets no network policy — the production shape.
//
// Before the fix every call failed twice over: `safeFetch` refused the peer's
// `localhost` host as a private range, and even with `allow_private_urls` the
// peer answered 401, because the tools sent no bearer token and never resolved
// the member's `authTokenRef`. Now a registered mesh member on a loopback host
// is reached directly (`meshFetch`), with the bearer resolved through the
// injected `SecretsResolver` (`meshAuthHeaders`); a non-loopback member still
// goes through the scoped fetch and its floor.

import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentMesh } from '@ethosagent/agent-mesh';
import type { AgentEvent, CapabilityBackends } from '@ethosagent/core';
import { AgentLoop, DefaultToolRegistry, InMemorySessionStore } from '@ethosagent/core';
import { FsStorage } from '@ethosagent/storage-fs';
import type { CompletionChunk, LLMProvider, SecretsResolver } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createBroadcastToAgentsTool,
  createDispatchTeamTool,
  createMeshAuthHeaderResolver,
  createRouteToAgentTool,
} from '../../../../extensions/tools-delegation/src/index';
import { createTestSafety } from '../../../../packages/core/src/__tests__/helpers/test-safety';
import { safeFetch } from '../../../../packages/safety/network/src/index';
import { AcpServer } from '../index';

const TOKEN = 'peer-bearer-token';
const REF = 'mesh/default/peer';

type Call = { id: string; name: string; input: unknown };

function scriptedLLM(steps: Array<Call[] | string>): LLMProvider {
  let i = 0;
  return {
    name: 'scripted',
    model: 'mock-model',
    maxContextTokens: 200_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(): AsyncIterable<CompletionChunk> {
      const step = steps[i++];
      if (step === undefined || typeof step === 'string') {
        yield { type: 'text_delta', text: step ?? 'ok' };
        yield { type: 'done', finishReason: 'end_turn' };
        return;
      }
      for (const tc of step) {
        yield { type: 'tool_use_start', toolCallId: tc.id, toolName: tc.name };
        yield { type: 'tool_use_end', toolCallId: tc.id, inputJson: JSON.stringify(tc.input) };
      }
      yield { type: 'done', finishReason: 'tool_use' };
    },
    async countTokens() {
      return 1;
    },
  };
}

function secretsWith(values: Record<string, string>): SecretsResolver {
  return {
    get: async (name) => values[name] ?? null,
    set: async () => {},
    delete: async () => {},
    list: async () => Object.keys(values),
  };
}

let meshDir: string;
let registryPath: string;
let httpServer: Server | undefined;

/** A peer the way `ethos serve --team` registers it: host `localhost`, a bearer
 *  token, and the NAME of the secret holding it (`authTokenRef`). */
async function startPeer(opts: { authTokenRef?: string; host?: string } = {}): Promise<void> {
  const loop = new AgentLoop({
    llm: scriptedLLM(['the peer answered']),
    tools: new DefaultToolRegistry(),
    safety: createTestSafety(),
  });
  const server = new AcpServer({
    runner: loop,
    session: new InMemorySessionStore(),
    authToken: TOKEN,
  });
  const listening = server.startHttp(0);
  httpServer = listening;
  await new Promise<void>((resolve) => listening.on('listening', () => resolve()));
  const addr = listening.address();
  const port = addr && typeof addr === 'object' ? addr.port : 0;
  await new AgentMesh(registryPath, { storage: new FsStorage() }).register({
    agentId: 'peer:1',
    capabilities: ['research'],
    model: 'mock-model',
    pid: process.pid,
    host: opts.host ?? 'localhost',
    port,
    activeSessions: 0,
    ...('authTokenRef' in opts
      ? opts.authTokenRef
        ? { authTokenRef: opts.authTokenRef }
        : {}
      : { authTokenRef: REF }),
  });
}

async function runSender(call: Call, secrets?: SecretsResolver) {
  // The production backends: the real `safeFetch`, and a personality with no
  // `safety.network` block (open internet, private ranges still refused).
  const backends: CapabilityBackends = { personalityNetworkPolicy: () => ({}), safeFetch };
  const tools = new DefaultToolRegistry(backends);
  const storage = new FsStorage();
  const mesh = secrets ? { secrets } : undefined;
  tools.register(createRouteToAgentTool(storage, registryPath, undefined, mesh));
  tools.register(createDispatchTeamTool(storage, registryPath, mesh));
  tools.register(createBroadcastToAgentsTool(storage, registryPath, mesh));
  const loop = new AgentLoop({
    llm: scriptedLLM([[call], 'sender done']),
    tools,
    safety: createTestSafety(),
  });
  const events: AgentEvent[] = [];
  for await (const e of loop.run('go')) events.push(e);
  const end = events.find((e) => e.type === 'tool_end' && e.toolName === call.name);
  return end?.type === 'tool_end' ? end : undefined;
}

const route: Call = {
  id: 'r',
  name: 'route_to_agent',
  input: { capability: 'research', prompt: 'look into it', retries: 0 },
};
const dispatch: Call = {
  id: 'd',
  name: 'dispatch_team',
  input: { tasks: [{ capability: 'research', prompt: 'look into it' }] },
};
const broadcast: Call = { id: 'b', name: 'broadcast_to_agents', input: { prompt: 'look into it' } };

beforeEach(() => {
  meshDir = mkdtempSync(join(tmpdir(), 'mesh-transport-'));
  registryPath = join(meshDir, 'registry.json');
});

afterEach(async () => {
  const open = httpServer;
  httpServer = undefined;
  if (open) await new Promise<void>((resolve) => open.close(() => resolve()));
  rmSync(meshDir, { recursive: true, force: true });
});

describe('mesh tools reach a real ethos serve peer on localhost', () => {
  it('route_to_agent authenticates with the resolved authTokenRef and gets the answer', async () => {
    await startPeer();
    const end = await runSender(route, secretsWith({ [REF]: TOKEN }));
    expect(end?.ok).toBe(true);
    expect(end?.result).toContain('the peer answered');
  });

  it('dispatch_team reaches the peer', async () => {
    await startPeer();
    const end = await runSender(dispatch, secretsWith({ [REF]: TOKEN }));
    expect(end?.ok).toBe(true);
    expect(end?.result).toContain('the peer answered');
  });

  it('broadcast_to_agents reaches the peer', async () => {
    await startPeer();
    const end = await runSender(broadcast, secretsWith({ [REF]: TOKEN }));
    expect(end?.ok).toBe(true);
    expect(end?.result).toContain('the peer answered');
  });
});

describe('a wrong or missing token is a clear error', () => {
  it('a wrong token: the 401 names the peer and its authTokenRef', async () => {
    await startPeer();
    const end = await runSender(route, secretsWith({ [REF]: 'not-the-token' }));
    expect(end?.ok).toBe(false);
    expect(end?.result).toMatch(/401/);
    expect(end?.result).toContain(REF);
  });

  it('an authTokenRef with no stored secret is refused before any request', async () => {
    await startPeer();
    const end = await runSender(route, secretsWith({}));
    expect(end?.ok).toBe(false);
    expect(end?.result).toContain(`secret "${REF}"`);
  });

  it('no SecretsResolver wired: the error says the token could not be resolved', async () => {
    await startPeer();
    const end = await runSender(route);
    expect(end?.ok).toBe(false);
    expect(end?.result).toContain(REF);
  });

  it('a peer that published no authTokenRef: the 401 says it shares no token', async () => {
    await startPeer({ authTokenRef: undefined });
    const end = await runSender(route, secretsWith({ [REF]: TOKEN }));
    expect(end?.ok).toBe(false);
    expect(end?.result).toMatch(/401/);
    expect(end?.result).toMatch(/no authTokenRef/);
  });
});

describe('the SSRF floor still applies off loopback', () => {
  it('a non-loopback private host goes through safeFetch and is refused', async () => {
    await startPeer({ host: '10.0.0.1' });
    const end = await runSender(route, secretsWith({ [REF]: TOKEN }));
    expect(end?.ok).toBe(false);
    expect(end?.result).toMatch(/private|HOST_NOT_ALLOWED/);
  });
});

describe('createMeshAuthHeaderResolver — the background proxy poll authenticates too', () => {
  it('resolves the bearer of the peer the registry lists at host:port', async () => {
    await startPeer();
    const [entry] = await new AgentMesh(registryPath, { storage: new FsStorage() }).list();
    const resolve = createMeshAuthHeaderResolver(new FsStorage(), registryPath, {
      secrets: secretsWith({ [REF]: TOKEN }),
    });
    const headers = await resolve('localhost', String(entry?.port));
    expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
    // A peer the registry does not list gets no token.
    expect((await resolve('localhost', '1')).Authorization).toBeUndefined();
  });
});
