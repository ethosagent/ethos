import { randomUUID } from 'node:crypto';
import type {
  SearchResult,
  Session,
  SessionFilter,
  SessionStore,
  StoredMessage,
} from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AcpServer, type AgentRunner } from '../index';

// ---------------------------------------------------------------------------
// In-memory SessionStore (same as auth.test.ts)
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
    async undoTurns() {
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AcpServer /notify', () => {
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

  it('POST /notify without auth returns 401', async () => {
    const res = await httpPost(port, '/notify', JSON.stringify({ kind: 'kanban' }));
    expect(res.status).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('Unauthorized');
  });

  it('POST /notify with valid auth returns 202', async () => {
    const res = await httpPost(
      port,
      '/notify',
      JSON.stringify({ kind: 'kanban', ref: 'task-123' }),
      { Authorization: `Bearer ${token}` },
    );
    expect(res.status).toBe(202);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(typeof body.queued).toBe('number');
  });

  it('POST /notify with missing kind returns 400', async () => {
    const res = await httpPost(port, '/notify', JSON.stringify({ ref: 'task-123' }), {
      Authorization: `Bearer ${token}`,
    });
    expect(res.status).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toContain('kind');
  });

  it('JSON-RPC notify method via POST /rpc returns result with ok: true', async () => {
    const rpcBody = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'notify',
      params: { kind: 'kanban', ref: 'task-456' },
    });
    const res = await httpPost(port, '/rpc', rpcBody, {
      Authorization: `Bearer ${token}`,
    });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.result.ok).toBe(true);
    expect(typeof body.result.queued).toBe('number');
  });
});
