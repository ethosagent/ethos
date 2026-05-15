import { randomUUID } from 'node:crypto';
import type {
  SearchResult,
  Session,
  SessionFilter,
  SessionStore,
  StoredMessage,
} from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { AcpServer, type AgentRunner } from '../index';

// ---------------------------------------------------------------------------
// In-memory SessionStore
// ---------------------------------------------------------------------------

function makeStore(): SessionStore {
  const sessions = new Map<string, Session>();
  const messages = new Map<string, StoredMessage[]>();

  return {
    async createSession(data) {
      const s: Session = {
        ...data,
        id: randomUUID(),
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      sessions.set(s.id, s);
      return s;
    },
    async getSession(id) {
      return sessions.get(id) ?? null;
    },
    async getSessionByKey(key) {
      for (const s of sessions.values()) if (s.key === key) return s;
      return null;
    },
    async updateSession(id, patch) {
      const s = sessions.get(id);
      if (s) sessions.set(id, { ...s, ...patch, updatedAt: new Date() });
    },
    async deleteSession(id) {
      sessions.delete(id);
      messages.delete(id);
    },
    async listSessions(_filter?: SessionFilter) {
      return [...sessions.values()];
    },
    async appendMessage(msg) {
      const stored: StoredMessage = { ...msg, id: randomUUID(), timestamp: new Date() };
      const list = messages.get(msg.sessionId) ?? [];
      list.push(stored);
      messages.set(msg.sessionId, list);
      return stored;
    },
    async getMessages(sessionId, opts) {
      const list = messages.get(sessionId) ?? [];
      if (opts?.limit !== undefined) return list.slice(-opts.limit);
      return list;
    },
    async updateUsage(_id, _delta) {},
    async search(_query, _opts): Promise<SearchResult[]> {
      return [];
    },
    async recordCompression(event) {
      return { ...event, id: randomUUID(), createdAt: new Date() };
    },
    async listCompressions(_sessionId) {
      return [];
    },
    async recordTurnStart(_sessionId) {
      return { turnNumber: 0, lastCompactionTurn: 0 };
    },
    async recordCompactionTurn(_sessionId, _turnNumber) {},
    async pruneOldSessions(_olderThan) {
      return 0;
    },
    async vacuum() {},
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRunner(): AgentRunner {
  return {
    run: async function* () {
      yield { type: 'text_delta', text: 'ok' };
      yield { type: 'done', text: 'ok', turnCount: 1 };
    },
  };
}

function jsonRpcBody(method: string, params: object = {}): string {
  return JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
}

async function httpPost(
  port: number,
  path: string,
  body: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body,
  });
  const text = await res.text();
  return { status: res.status, body: text };
}

async function httpGet(
  port: number,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'GET',
    headers,
  });
  const text = await res.text();
  return { status: res.status, body: text };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AcpServer HTTP auth', () => {
  let server: AcpServer;
  let httpServer: ReturnType<typeof import('node:http').createServer>;
  let port: number;
  let token: string;

  beforeEach(async () => {
    const store = makeStore();
    server = new AcpServer({
      runner: makeRunner(),
      session: store,
      authToken: 'test-secret-token',
    });
    token = server.token;
    httpServer = server.startHttp(0);
    // Wait for server to be listening and get the assigned port
    await new Promise<void>((resolve) => {
      httpServer.on('listening', () => {
        const addr = httpServer.address();
        if (addr && typeof addr === 'object') {
          port = addr.port;
        }
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
    });
  });

  it('GET /health returns 200 without auth', async () => {
    const res = await httpGet(port, '/health');
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe('ok');
  });

  it('POST /rpc without bearer returns 401', async () => {
    const res = await httpPost(port, '/rpc', jsonRpcBody('initialize'));
    expect(res.status).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('Unauthorized');
  });

  it('POST /rpc with wrong bearer returns 401', async () => {
    const res = await httpPost(port, '/rpc', jsonRpcBody('initialize'), {
      Authorization: 'Bearer wrong-token',
    });
    expect(res.status).toBe(401);
  });

  it('POST /rpc with correct bearer returns 200', async () => {
    const res = await httpPost(port, '/rpc', jsonRpcBody('initialize'), {
      Authorization: `Bearer ${token}`,
    });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.result.protocolVersion).toBe('1.0');
  });

  it('WebSocket upgrade without bearer is rejected', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const error = await new Promise<{ code: number }>((resolve) => {
      ws.on('unexpected-response', (_req, res) => {
        resolve({ code: res.statusCode ?? 0 });
      });
      ws.on('error', () => {
        // Connection might be destroyed before the response is fully parsed
        resolve({ code: 401 });
      });
    });
    expect(error.code).toBe(401);
  });

  it('WebSocket upgrade with correct bearer succeeds', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const opened = await new Promise<boolean>((resolve) => {
      ws.on('open', () => resolve(true));
      ws.on('error', () => resolve(false));
    });
    expect(opened).toBe(true);
    ws.close();
  });

  it('WebSocket upgrade with wrong bearer is rejected', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: { Authorization: 'Bearer wrong' },
    });
    const error = await new Promise<{ code: number }>((resolve) => {
      ws.on('unexpected-response', (_req, res) => {
        resolve({ code: res.statusCode ?? 0 });
      });
      ws.on('error', () => {
        resolve({ code: 401 });
      });
    });
    expect(error.code).toBe(401);
  });

  it('WebSocket upgrade with disallowed origin is rejected', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Origin: 'http://evil.example.com',
      },
    });
    const error = await new Promise<{ code: number }>((resolve) => {
      ws.on('unexpected-response', (_req, res) => {
        resolve({ code: res.statusCode ?? 0 });
      });
      ws.on('error', () => {
        resolve({ code: 403 });
      });
    });
    expect(error.code).toBe(403);
  });

  it('WebSocket upgrade with localhost origin succeeds', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Origin: 'http://localhost:3000',
      },
    });
    const opened = await new Promise<boolean>((resolve) => {
      ws.on('open', () => resolve(true));
      ws.on('error', () => resolve(false));
    });
    expect(opened).toBe(true);
    ws.close();
  });

  it('token getter returns the configured auth token', () => {
    expect(server.token).toBe('test-secret-token');
  });

  it('generates a random token when none is provided', () => {
    const store = makeStore();
    const s = new AcpServer({ runner: makeRunner(), session: store });
    // 32 random bytes = 64 hex characters
    expect(s.token).toMatch(/^[0-9a-f]{64}$/);
  });
});
