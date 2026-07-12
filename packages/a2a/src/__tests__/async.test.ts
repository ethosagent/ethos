// Async task lifecycle (plan §10 / §17 Phase 6) — the responder manager and the
// initiator tracker, plus the distinct terminal states expired vs peer-unreachable.

import type { AgentEvent } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import {
  A2aAsyncManager,
  A2aInitiatorTracker,
  type A2aPushClient,
  FetchA2aPushClient,
} from '../async';
import { generateEd25519, rawPublicKeyFromPem, verifyStruct } from '../crypto';
import type { A2aTaskRunner } from '../rpc';
import { InMemoryA2aTaskStore } from '../task-store';

function scriptRunner(script: AgentEvent[], counter: { runs: number }): A2aTaskRunner {
  return {
    async *run() {
      counter.runs += 1;
      for (const e of script) yield e;
    },
  };
}

const HELLO: AgentEvent[] = [
  { type: 'text_delta', text: 'hello world' },
  { type: 'done', text: 'hello world', turnCount: 1 },
];

describe('A2aAsyncManager — completion', () => {
  it('runs in the background and settles completed with the assistant text', async () => {
    const store = new InMemoryA2aTaskStore();
    const counter = { runs: 0 };
    const mgr = new A2aAsyncManager({ taskStore: store, runner: scriptRunner(HELLO, counter) });

    const task = await mgr.submit({
      personalityId: 'researcher',
      peerFingerprint: 'fp-a',
      message: 'hi',
      sessionKey: 's',
      traceId: 't',
      depth: 0,
      idempotencyKey: 'k1',
    });
    expect(task.status).toBe('submitted');

    const settled = await mgr.settled(task.id);
    expect(settled?.status).toBe('completed');
    expect(settled?.result).toBe('hello world');
    expect(counter.runs).toBe(1);
  });

  it('maps a runner error to failed (not a catch-all)', async () => {
    const store = new InMemoryA2aTaskStore();
    const counter = { runs: 0 };
    const mgr = new A2aAsyncManager({
      taskStore: store,
      runner: scriptRunner([{ type: 'error', error: 'boom', code: 'INTERNAL' }], counter),
    });
    const task = await mgr.submit({
      personalityId: 'researcher',
      peerFingerprint: 'fp-a',
      message: 'hi',
      sessionKey: 's',
      traceId: 't',
      depth: 0,
      idempotencyKey: 'k',
    });
    const settled = await mgr.settled(task.id);
    expect(settled?.status).toBe('failed');
    expect(settled?.error).toBe('boom');
  });
});

describe('A2aAsyncManager — idempotency dedupe (no double run)', () => {
  it('a retried send with the same key returns the prior task and runs EXACTLY once', async () => {
    const store = new InMemoryA2aTaskStore();
    const counter = { runs: 0 };
    const mgr = new A2aAsyncManager({ taskStore: store, runner: scriptRunner(HELLO, counter) });
    const args = {
      personalityId: 'researcher',
      peerFingerprint: 'fp-a',
      message: 'hi',
      sessionKey: 's',
      traceId: 't',
      depth: 0,
      idempotencyKey: 'same-key',
    } as const;

    const first = await mgr.submit(args);
    await mgr.settled(first.id);
    const second = await mgr.submit(args);

    expect(second.id).toBe(first.id);
    expect(counter.runs).toBe(1);
  });

  it('scopes the idempotency key by peer fingerprint', async () => {
    const store = new InMemoryA2aTaskStore();
    const counter = { runs: 0 };
    const mgr = new A2aAsyncManager({ taskStore: store, runner: scriptRunner(HELLO, counter) });
    const base = {
      personalityId: 'researcher',
      message: 'hi',
      sessionKey: 's',
      traceId: 't',
      depth: 0,
      idempotencyKey: 'k',
    };
    const a = await mgr.submit({ ...base, peerFingerprint: 'fp-a' });
    await mgr.settled(a.id);
    const b = await mgr.submit({ ...base, peerFingerprint: 'fp-b' });
    await mgr.settled(b.id);
    expect(b.id).not.toBe(a.id);
    expect(counter.runs).toBe(2);
  });
});

describe('A2aAsyncManager — push-back → peer-unreachable', () => {
  it('settles peer-unreachable when delivery fails after retries (NOT failed)', async () => {
    const store = new InMemoryA2aTaskStore();
    const counter = { runs: 0 };
    let attempts = 0;
    const brokenPush: A2aPushClient = {
      async push() {
        attempts += 1;
        throw new Error('connection refused');
      },
    };
    const mgr = new A2aAsyncManager({
      taskStore: store,
      runner: scriptRunner(HELLO, counter),
      pushClient: brokenPush,
      pushRetries: 3,
    });

    const task = await mgr.submit({
      personalityId: 'researcher',
      peerFingerprint: 'fp-a',
      message: 'hi',
      sessionKey: 's',
      traceId: 't',
      depth: 0,
      idempotencyKey: 'k',
      pushBack: { url: 'http://peer/a2a/initiator', token: 'tok' },
    });
    const settled = await mgr.settled(task.id);
    expect(settled?.status).toBe('peer-unreachable');
    // The run itself DID complete — the result is preserved despite delivery failure.
    expect(settled?.result).toBe('hello world');
    expect(attempts).toBe(3);
  });

  it('settles completed when push-back succeeds', async () => {
    const store = new InMemoryA2aTaskStore();
    const counter = { runs: 0 };
    const delivered: unknown[] = [];
    const okPush: A2aPushClient = {
      async push(_target, payload) {
        delivered.push(payload);
      },
    };
    const mgr = new A2aAsyncManager({
      taskStore: store,
      runner: scriptRunner(HELLO, counter),
      pushClient: okPush,
    });
    const task = await mgr.submit({
      personalityId: 'researcher',
      peerFingerprint: 'fp-a',
      message: 'hi',
      sessionKey: 's',
      traceId: 't',
      depth: 0,
      idempotencyKey: 'k',
      pushBack: { url: 'http://peer/a2a/initiator' },
    });
    const settled = await mgr.settled(task.id);
    expect(settled?.status).toBe('completed');
    expect(delivered).toHaveLength(1);
  });
});

describe('FetchA2aPushClient — outbound push-back proof-of-possession (Phase 7)', () => {
  it('attaches a verifiable PoP over the tasks/pushResult struct when signing material is supplied', async () => {
    const { privateKeyPem } = generateEd25519();
    const responderPublicKey = rawPublicKeyFromPem(privateKeyPem);
    let capturedHeaders: Headers | null = null;
    const fetchImpl: typeof fetch = async (_input, init) => {
      capturedHeaders = new Headers(init?.headers);
      return new Response(null, { status: 200 });
    };
    const client = new FetchA2aPushClient(fetchImpl, () => 1000);

    await client.push(
      {
        url: 'http://initiator/a2a/initiator',
        token: 'tok',
        signingKeyPem: privateKeyPem,
        tokenJti: 'jti-xyz',
      },
      { taskId: 't1', status: 'completed', result: 'done' },
    );

    const headers = capturedHeaders ?? new Headers();
    expect(headers.get('authorization')).toBe('Bearer tok');
    expect(headers.get('x-a2a-pop-timestamp')).toBe('1000');
    const sig = headers.get('x-a2a-pop') ?? '';
    expect(sig).not.toBe('');
    // The signature verifies against the RESPONDER's public key over the exact
    // struct the initiator's /a2a endpoint reconstructs.
    const verified = verifyStruct(
      { context: 'a2a-request-pop', method: 'tasks/pushResult', jti: 'jti-xyz', timestamp: 1000 },
      sig,
      responderPublicKey,
    );
    expect(verified).toBe(true);
  });

  it('stays bearer-only (no PoP headers) when signing material is absent', async () => {
    let capturedHeaders: Headers | null = null;
    const fetchImpl: typeof fetch = async (_input, init) => {
      capturedHeaders = new Headers(init?.headers);
      return new Response(null, { status: 200 });
    };
    const client = new FetchA2aPushClient(fetchImpl);

    await client.push(
      { url: 'http://initiator/a2a/initiator', token: 'tok' },
      { taskId: 't1', status: 'completed', result: 'done' },
    );

    const headers = capturedHeaders ?? new Headers();
    expect(headers.get('authorization')).toBe('Bearer tok');
    expect(headers.get('x-a2a-pop')).toBeNull();
    expect(headers.get('x-a2a-pop-timestamp')).toBeNull();
  });
});

describe('A2aInitiatorTracker — initiator timeout → expired', () => {
  it('settles expired when the push-back never arrives before the timeout', async () => {
    const store = new InMemoryA2aTaskStore();
    const tracker = new A2aInitiatorTracker({ taskStore: store });
    const { task, settled } = await tracker.open({
      peerFingerprint: 'fp-a',
      traceId: 't',
      idempotencyKey: 'k',
      timeoutMs: 20,
    });
    expect(task.status).toBe('working');
    const final = await settled;
    expect(final.status).toBe('expired');
  });

  it('settles completed when the push-back arrives before the timeout', async () => {
    const store = new InMemoryA2aTaskStore();
    const tracker = new A2aInitiatorTracker({ taskStore: store });
    const { task, settled } = await tracker.open({
      peerFingerprint: 'fp-a',
      traceId: 't',
      idempotencyKey: 'k',
      timeoutMs: 5_000,
    });
    await tracker.resolve(task.id, 'the answer');
    const final = await settled;
    expect(final.status).toBe('completed');
    expect(final.result).toBe('the answer');
  });
});
