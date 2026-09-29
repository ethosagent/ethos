// plan personality-memory-boundary-and-self-amendment — the initiator table's
// web rows, and the G2 filing gate they feed (G2-4):
//   - web chat, cookie session → `initiator: 'user'`
//   - web chat, bearer API key  → `initiator: 'system'`
//   - web chat, no auth method recorded → `initiator: 'system'` (fails closed)
// `chatSend` (features/chat/rpc/send.ts) decides it from `_authMethod`,
// `ChatService.send` forwards it to `loop.run`, and the self-amendment intake
// (`createAmendmentIntake`, packages/wiring/src/amendments.ts) files only for
// `'user'`. So a bearer-key web turn cannot file; a cookie web turn can.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStreamBuffer } from '@ethosagent/agent-bridge';
import { DefaultToolRegistry, InMemorySessionStore } from '@ethosagent/core';
import { noopLogger } from '@ethosagent/logger';
import { FilePersonalityRegistry } from '@ethosagent/personalities';
import { SQLiteSessionStore } from '@ethosagent/session-sqlite';
import { FsStorage } from '@ethosagent/storage-fs';
import type { ToolContext, TurnInitiator } from '@ethosagent/types';
import type { ActivityEvent, SseEvent } from '@ethosagent/web-contracts';
import { createAmendmentIntake } from '@ethosagent/wiring';
import { call } from '@orpc/server';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChatRepository } from '../../features/chat/repository';
import { chatSend } from '../../features/chat/rpc/send';
import { ChatService } from '../../features/chat/service';
import { AUTH_COOKIE, authMiddleware } from '../../middleware/auth';
import { makeStubAgentLoop } from '../test-helpers';

describe('web chat initiator (cookie → user, bearer → system)', () => {
  let store: SQLiteSessionStore;
  let buffer: SessionStreamBuffer<SseEvent>;
  let activityBuffer: SessionStreamBuffer<ActivityEvent>;
  let root: string;

  beforeEach(() => {
    store = new SQLiteSessionStore(':memory:');
    buffer = new SessionStreamBuffer<SseEvent>();
    activityBuffer = new SessionStreamBuffer<ActivityEvent>();
    root = mkdtempSync(join(tmpdir(), 'ethos-chat-initiator-'));
  });

  afterEach(() => {
    buffer.destroy();
    activityBuffer.destroy();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  /** Send one message through the RPC handler; resolve the `RunOptions` the loop saw. */
  async function runOptsFor(authMethod: 'cookie' | 'bearer' | undefined) {
    let seen: { initiator?: TurnInitiator; sessionKey?: string } | undefined;
    const ran = new Promise<void>((resolve) => {
      const service = new ChatService({
        loop: makeStubAgentLoop({
          onRun: (_input, opts) => {
            seen = opts as typeof seen;
            resolve();
          },
        }),
        sessions: new ChatRepository(store),
        buffer,
        activityBuffer,
        defaults: { model: 'claude-test', provider: 'anthropic' },
      });
      const context = { chat: service, ...(authMethod ? { _authMethod: authMethod } : {}) };
      void call(chatSend, { clientId: 'tab-1', text: 'hi' }, { context: context as never });
    });
    await ran;
    return seen;
  }

  it('a cookie session starts a user turn', async () => {
    expect((await runOptsFor('cookie'))?.initiator).toBe('user');
  });

  it('an absent auth method fails closed → system (only a positive cookie is a person)', async () => {
    expect((await runOptsFor(undefined))?.initiator).toBe('system');
  });

  it('the cookie-only authMiddleware records a positive cookie, so its turns stay user', async () => {
    const app = new Hono();
    app.use('*', authMiddleware({ verify: async () => true }));
    app.get('/probe', (c) => c.text(String(c.get('authMethod'))));
    const res = await app.request('/probe', { headers: { cookie: `${AUTH_COOKIE}=t` } });
    expect(await res.text()).toBe('cookie');
  });

  it('a bearer API key starts a system turn', async () => {
    expect((await runOptsFor('bearer'))?.initiator).toBe('system');
  });

  it('a bearer web turn cannot file a self-amendment; a cookie web turn can', async () => {
    const dataDir = join(root, '.ethos');
    const dir = join(dataDir, 'personalities', 'scout');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'config.yaml'), 'name: scout\n');
    writeFileSync(join(dir, 'SOUL.md'), '# scout\n');
    writeFileSync(join(dir, 'toolset.yaml'), '- read_file\n- propose_self_amendment\n');
    const storage = new FsStorage();
    const personalities = new FilePersonalityRegistry(storage, dataDir);
    await personalities.loadFromDirectory(join(dataDir, 'personalities'));
    const tools = new DefaultToolRegistry();
    tools.register({
      name: 'terminal',
      description: 'shell',
      schema: {},
      capabilities: {},
      execute: async () => ({ ok: true, value: '' }),
    });
    const intake = createAmendmentIntake({
      storage,
      dataDir,
      workingDir: root,
      personalities,
      tools,
      sessions: new InMemorySessionStore(),
      log: noopLogger,
    });
    const fileFrom = async (authMethod: 'cookie' | 'bearer') => {
      const opts = await runOptsFor(authMethod);
      const ctx = {
        sessionId: `s-${authMethod}`,
        sessionKey: opts?.sessionKey ?? '',
        platform: 'web',
        personalityId: 'scout',
        roomAudience: 'private',
        ...(opts?.initiator ? { initiator: opts.initiator } : {}),
      } as ToolContext;
      return intake.submit({ ops: [{ op: 'add_tool', tool: 'terminal' }], rationale: 'r' }, ctx);
    };

    const bearer = await fileFrom('bearer');
    expect(bearer).toMatchObject({ ok: false, reason: expect.stringMatching(/a person started/) });
    const cookie = await fileFrom('cookie');
    expect(cookie).toMatchObject({ ok: true, status: 'pending' });
  });
});
