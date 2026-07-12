// Phase 8 acceptance gate — the metadata-only audit sink (plan §13 / O12).
//
// The sink records THAT an A2A exchange happened, never WHAT was said. These
// tests pin three properties:
//   1. An accepted exchange and a denied exchange each emit the expected record
//      with the right metadata — and NO body/token/secret field.
//   2. A throwing sink NEVER changes the auth/RPC outcome (fail-open, §13).
//   3. The async lifecycle records working → terminal task-state transitions.

import { describe, expect, it } from 'vitest';
import { A2aAsyncManager } from '../async';
import type { A2aAuditEntry, A2aAuditSink } from '../audit';
import { A2A_METHOD_MESSAGE_SEND, type A2aRequestCredentials, createA2aRpcService } from '../rpc';
import { InMemoryA2aTaskStore } from '../task-store';
import {
  type Agent,
  countingRunner,
  HELLO_SCRIPT,
  makeAgent,
  mintPeerToken,
  newPeerStore,
  type SheetHolder,
  signPop,
  stubIdentity,
  TARGET_ID,
} from './a2a-fixtures';

// The complete key set of A2aAuditEntry — an entry must never carry anything
// outside this (no `message`, `token`, `secret`, `body`, …).
const ALLOWED_KEYS = new Set([
  'kind',
  'event',
  'personalityId',
  'peerFingerprint',
  'skill',
  'taskId',
  'traceId',
  'decision',
  'reason',
  'status',
  'severity',
  'ts',
]);

function assertMetadataOnly(records: A2aAuditEntry[]): void {
  for (const rec of records) {
    for (const key of Object.keys(rec)) {
      expect(ALLOWED_KEYS.has(key)).toBe(true);
    }
    for (const forbidden of ['message', 'token', 'secret', 'body', 'content', 'proofSignature']) {
      expect(Object.hasOwn(rec, forbidden)).toBe(false);
    }
  }
}

function spySink() {
  const records: A2aAuditEntry[] = [];
  const sink: A2aAuditSink = { record: (e) => records.push(e) };
  return { records, sink };
}

function makeAuditedService(sheetSkills: string[], auditSink: A2aAuditSink) {
  const target = makeAgent(TARGET_ID);
  const peer = makeAgent('peer-a');
  const sheet: SheetHolder = { skills: sheetSkills };
  const peerStore = newPeerStore();
  const clock = { t: Date.now() };
  const service = createA2aRpcService({
    getIdentity: stubIdentity(target, sheet),
    peerStore,
    runner: countingRunner(HELLO_SCRIPT, { runs: 0 }),
    now: () => clock.t,
    auditSink,
  });
  return { target, peer, peerStore, clock, service };
}

function credsFor(peer: Agent, token: string, jti: string, ts: number): A2aRequestCredentials {
  return {
    token,
    proofSignature: signPop(peer, A2A_METHOD_MESSAGE_SEND, jti, ts),
    proofTimestamp: ts,
  };
}

function rpcRequest(skill: string, message = 'a private message body') {
  return {
    jsonrpc: '2.0' as const,
    id: 1,
    method: A2A_METHOD_MESSAGE_SEND,
    params: { skill, message },
  };
}

describe('A2A audit — accepted exchange', () => {
  it('emits exactly one accepted rpc dispatch with clean metadata (no body)', async () => {
    const spy = spySink();
    const { target, peer, peerStore, clock, service } = makeAuditedService(['search'], spy.sink);
    const minted = await mintPeerToken(target, peer, ['search'], peerStore, { now: clock.t });
    const c = credsFor(peer, minted.token, minted.claims.jti, clock.t);

    const res = await service.handleRpc(TARGET_ID, rpcRequest('search'), c);
    expect('result' in res).toBe(true);

    const rpcRecords = spy.records.filter((r) => r.kind === 'rpc');
    expect(rpcRecords).toHaveLength(1);
    expect(rpcRecords[0]).toMatchObject({
      kind: 'rpc',
      event: 'message/send',
      personalityId: TARGET_ID,
      peerFingerprint: peer.fingerprint,
      skill: 'search',
      decision: 'accepted',
      severity: 'info',
    });

    // The sync terminal task-state record is also emitted.
    const taskRecords = spy.records.filter((r) => r.kind === 'task');
    expect(taskRecords).toHaveLength(1);
    expect(taskRecords[0]).toMatchObject({ status: 'completed', decision: 'accepted' });

    assertMetadataOnly(spy.records);
    expect(JSON.stringify(spy.records)).not.toContain('a private message body');
  });
});

describe('A2A audit — denied exchange', () => {
  it('emits exactly one denied record with the reason label (skill out of scope)', async () => {
    const spy = spySink();
    // Sheet has both; token grants only 'search' → request 'delete' is out of scope.
    const { target, peer, peerStore, clock, service } = makeAuditedService(
      ['search', 'delete'],
      spy.sink,
    );
    const minted = await mintPeerToken(target, peer, ['search'], peerStore, { now: clock.t });
    const c = credsFor(peer, minted.token, minted.claims.jti, clock.t);

    const res = await service.handleRpc(TARGET_ID, rpcRequest('delete'), c);
    expect('error' in res && res.error.code).toBe(-32003);

    expect(spy.records).toHaveLength(1);
    expect(spy.records[0]).toMatchObject({
      kind: 'rpc',
      event: 'message/send',
      personalityId: TARGET_ID,
      peerFingerprint: peer.fingerprint,
      decision: 'denied',
      reason: 'forbidden-scope',
      severity: 'warn',
    });
    assertMetadataOnly(spy.records);
  });

  it('records an unauthorized denial before peer identification (no peerFingerprint)', async () => {
    const spy = spySink();
    const { service } = makeAuditedService(['search'], spy.sink);
    const res = await service.handleRpc(TARGET_ID, rpcRequest('search'), {
      token: null,
      proofSignature: null,
      proofTimestamp: null,
    });
    expect('error' in res && res.error.code).toBe(-32001);
    expect(spy.records).toHaveLength(1);
    expect(spy.records[0]).toMatchObject({ decision: 'denied', reason: 'unauthorized' });
    expect(spy.records[0]?.peerFingerprint).toBeUndefined();
    assertMetadataOnly(spy.records);
  });
});

describe('A2A audit — fail-open (a throwing sink never changes the outcome)', () => {
  const throwingSink: A2aAuditSink = {
    record() {
      throw new Error('sink is on fire');
    },
  };

  it('an accepted request still completes with a throwing sink', async () => {
    const { target, peer, peerStore, clock, service } = makeAuditedService(
      ['search'],
      throwingSink,
    );
    const minted = await mintPeerToken(target, peer, ['search'], peerStore, { now: clock.t });
    const c = credsFor(peer, minted.token, minted.claims.jti, clock.t);

    const res = await service.handleRpc(TARGET_ID, rpcRequest('search'), c);
    expect('result' in res).toBe(true);
    if ('result' in res) {
      const result = res.result as { state: string };
      expect(result.state).toBe('completed');
    }
  });

  it('a denied request still returns its error with a throwing sink', async () => {
    const { service } = makeAuditedService(['search'], throwingSink);
    const res = await service.handleRpc(TARGET_ID, rpcRequest('search'), {
      token: null,
      proofSignature: null,
      proofTimestamp: null,
    });
    expect('error' in res && res.error.code).toBe(-32001);
  });
});

describe('A2A audit — async task-state lifecycle', () => {
  it('records working then completed for a background task', async () => {
    const spy = spySink();
    const store = new InMemoryA2aTaskStore();
    const manager = new A2aAsyncManager({
      taskStore: store,
      runner: countingRunner(HELLO_SCRIPT, { runs: 0 }),
      auditSink: spy.sink,
    });
    const task = await manager.submit({
      personalityId: TARGET_ID,
      peerFingerprint: 'peer-fp',
      message: 'a private message body',
      sessionKey: 'a2a:test',
      traceId: 'trace-1',
      depth: 0,
      idempotencyKey: 'idem-1',
    });
    await manager.settled(task.id);

    const statuses = spy.records.map((r) => r.status);
    expect(statuses).toEqual(['working', 'completed']);
    for (const rec of spy.records) {
      expect(rec).toMatchObject({
        kind: 'task',
        event: 'task-state',
        personalityId: TARGET_ID,
        peerFingerprint: 'peer-fp',
        taskId: task.id,
        traceId: 'trace-1',
      });
    }
    assertMetadataOnly(spy.records);
    expect(JSON.stringify(spy.records)).not.toContain('a private message body');
  });
});
