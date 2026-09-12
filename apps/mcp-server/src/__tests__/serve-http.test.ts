// B-T3: HTTP mode used to connect ONE shared `Server` to every session
// transport, so the second session died on SDK 1.29.0's
// `Already connected to a transport`; and an unauthenticated loopback server
// with no Host validation is reachable from any page via DNS rebinding.

import { request } from 'node:http';
import type { AgentEvent, AgentLoop } from '@ethosagent/core';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import { createMemoryProviderFromConfig } from '@ethosagent/wiring';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it } from 'vitest';
import { EthosMcpServer } from '../server';

const noopLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const stubLoop = {
  run: (): AsyncGenerator<AgentEvent> =>
    (async function* () {
      yield { type: 'done' as const, text: 'ok', turnCount: 1 };
    })(),
} as unknown as AgentLoop;

function makeServer(): EthosMcpServer {
  return new EthosMcpServer({
    loop: stubLoop,
    dataDir: '/data',
    storage: new InMemoryStorage(),
    logger: noopLogger,
  });
}

/** POST with an arbitrary Host header — `fetch` refuses to set one. */
function postWithHost(port: number, host: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path: '/mcp',
        method: 'POST',
        headers: {
          Host: host,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += String(chunk);
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'attacker', version: '1' },
        },
      }),
    );
  });
}

const openServers: EthosMcpServer[] = [];

afterEach(async () => {
  while (openServers.length > 0) {
    const server = openServers.pop();
    await server?.close();
  }
});

describe('EthosMcpServer.serveHttp', () => {
  it('refuses non-loopback hosts', async () => {
    const server = makeServer();
    await expect(server.serveHttp({ port: 3300, host: '0.0.0.0' })).rejects.toThrow('loopback');
  });

  it('two sequential sessions both initialize', async () => {
    const server = makeServer();
    openServers.push(server);
    const handle = await server.serveHttp({ port: 0 });
    const url = new URL(`http://127.0.0.1:${handle.port}/mcp`);

    const first = new Client({ name: 'first', version: '1' });
    await first.connect(new StreamableHTTPClientTransport(url));
    const firstTools = await first.listTools();
    expect(firstTools.tools.map((t) => t.name)).toContain('ask_personality');
    await first.close();

    // Before the fix this threw `Already connected to a transport`.
    const second = new Client({ name: 'second', version: '1' });
    await second.connect(new StreamableHTTPClientTransport(url));
    const secondTools = await second.listTools();
    expect(secondTools.tools.map((t) => t.name)).toContain('ask_personality');
    await second.close();
  });

  it('answers 403 to a rebound Host header', async () => {
    const server = makeServer();
    openServers.push(server);
    const handle = await server.serveHttp({ port: 0 });

    const rebound = await postWithHost(handle.port, 'evil.example');
    expect(rebound.status).toBe(403);

    const allowed = await postWithHost(handle.port, `127.0.0.1:${handle.port}`);
    expect(allowed.status).toBe(200);
  });

  it('allows the loopback names on the bound port only', async () => {
    const server = makeServer();
    openServers.push(server);
    const handle = await server.serveHttp({ port: 0 });
    expect(handle.allowedHosts).toContain(`127.0.0.1:${handle.port}`);
    expect(handle.allowedHosts).toContain(`localhost:${handle.port}`);
    expect(handle.allowedHosts).not.toContain('127.0.0.1');
  });
});

describe('memory tools are listed when a provider is wired (as `ethos mcp serve` wires one)', () => {
  it('lists search_memory, read_memory and write_memory', async () => {
    const storage = new InMemoryStorage();
    const provider = createMemoryProviderFromConfig({
      config: {},
      dataDir: '/data',
      storage,
    }).provider;
    const server = new EthosMcpServer({
      loop: stubLoop,
      dataDir: '/data',
      storage,
      logger: noopLogger,
      memoryProvider: provider,
      enableMemoryWrite: true,
    });
    openServers.push(server);
    const handle = await server.serveHttp({ port: 0 });
    const client = new Client({ name: 'c', version: '1' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${handle.port}/mcp`)),
    );
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain('search_memory');
    expect(names).toContain('read_memory');
    expect(names).toContain('write_memory');
    await client.close();
  });

  it('lists none of them without a provider', async () => {
    const server = makeServer();
    openServers.push(server);
    const handle = await server.serveHttp({ port: 0 });
    const client = new Client({ name: 'c', version: '1' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${handle.port}/mcp`)),
    );
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain('read_memory');
    expect(names).not.toContain('write_memory');
    await client.close();
  });
});

describe('ask_personality over HTTP', () => {
  it('takes no session_key and returns a conversation id', async () => {
    const server = makeServer();
    openServers.push(server);
    const handle = await server.serveHttp({ port: 0 });
    const client = new Client({ name: 'c', version: '1' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${handle.port}/mcp`)),
    );

    const tools = await client.listTools();
    const ask = tools.tools.find((t) => t.name === 'ask_personality');
    expect(Object.keys(ask?.inputSchema.properties ?? {})).not.toContain('session_key');

    const result = (await client.callTool({
      name: 'ask_personality',
      arguments: { personality_id: 'engineer', prompt: 'hi' },
    })) as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBeFalsy();
    const handleBlock = JSON.parse(result.content[result.content.length - 1]?.text ?? '{}') as {
      conversation?: string;
    };
    expect(handleBlock.conversation).toMatch(/^[A-Za-z0-9_-]{1,64}$/);

    await client.close();
  });

  it('a refused turn is an isError result carrying the code', async () => {
    const refusing = {
      run: (): AsyncGenerator<AgentEvent> =>
        (async function* () {
          yield {
            type: 'error' as const,
            error: 'turn budget exhausted',
            code: 'BUDGET_EXCEEDED',
          };
          yield { type: 'done' as const, text: '', turnCount: 1 };
        })(),
    } as unknown as AgentLoop;
    const server = new EthosMcpServer({
      loop: refusing,
      dataDir: '/data',
      storage: new InMemoryStorage(),
      logger: noopLogger,
    });
    openServers.push(server);
    const handle = await server.serveHttp({ port: 0 });
    const client = new Client({ name: 'c', version: '1' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${handle.port}/mcp`)),
    );

    const result = (await client.callTool({
      name: 'ask_personality',
      arguments: { personality_id: 'engineer', prompt: 'hi' },
    })) as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('BUDGET_EXCEEDED');

    await client.close();
  });

  it('rejects a conversation containing ":"', async () => {
    const server = makeServer();
    openServers.push(server);
    const handle = await server.serveHttp({ port: 0 });
    const client = new Client({ name: 'c', version: '1' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${handle.port}/mcp`)),
    );

    const result = (await client.callTool({
      name: 'ask_personality',
      arguments: { personality_id: 'engineer', prompt: 'hi', conversation: 'cli:ethos' },
    })) as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('input_invalid');

    await client.close();
  });
});
