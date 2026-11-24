import { describe, expect, it } from 'vitest';
import {
  type AnyNodeFrame,
  decodeNodeFrame,
  decodePairClientFrame,
  decodePairServerFrame,
  decodeServerFrame,
  decodeToolExecuteRequest,
  decodeToolResult,
  encodeFrame,
  NODE_FRAME_MAX_BYTES,
} from '../frames';

const request = {
  toolCallId: 'tc1',
  name: 'read_file',
  args: { path: 'a.txt' },
  sessionId: 's1',
  sessionKey: 'cli:s1',
  platform: 'cli',
  workingDir: '/srv/work',
  currentTurn: 1,
  messageCount: 2,
  resultBudgetChars: 4000,
};

const fullRequest = {
  ...request,
  personalityId: 'coder',
  teamId: 't',
  agentId: 'a',
  rootSessionKey: 'r',
  jobId: 'j',
  reviewOfJobId: 'rj',
  origin: 'o',
  memoryScopeId: 'm',
  userScopeId: 'u',
  roomAudience: 'private',
  initiator: 'user',
  toolsetNarrowing: { narrow: ['a'], exclude: ['b'] },
  networkPolicy: { allow: ['x'], deny: ['y'], allow_private_urls: false },
  dryRun: true,
};

const nodeFrames: AnyNodeFrame[] = [
  {
    v: 1,
    kind: 'hello',
    name: 'laptop',
    roots: [{ path: '/Users/me/app', readOnly: false }],
    tools: ['read_file'],
    personalities: ['*'],
    clock: 1000,
  },
  { v: 1, kind: 'progress', callId: 'c1', message: 'working', audience: 'internal' },
  { v: 1, kind: 'progress', callId: 'c1', message: 'no audience' },
  {
    v: 1,
    kind: 'result',
    callId: 'c1',
    result: { ok: true, value: 'hi', structured: { a: 1 }, cost_usd: 0.1 },
  },
  {
    v: 1,
    kind: 'result',
    callId: 'c1',
    result: { ok: false, code: 'input_invalid', error: 'bad', field: 'path' },
  },
  {
    v: 1,
    kind: 'result',
    callId: 'c1',
    result: { ok: false, code: 'not_available', error: 'no', reason: 'x' },
  },
  {
    v: 1,
    kind: 'result',
    callId: 'c1',
    result: { ok: false, code: 'execution_failed', error: 'e', cause: { a: [1] } },
  },
  {
    v: 1,
    kind: 'result',
    callId: 'c1',
    result: { ok: false, code: 'STALE_WRITE', error: 's', conflictKey: 'k' },
  },
  { v: 1, kind: 'ping', at: 5 },
  { v: 1, kind: 'pong', at: 5 },
];

const serverFrames: AnyNodeFrame[] = [
  { v: 1, kind: 'call', callId: 'c1', deadline: 9999, request: request },
  { v: 1, kind: 'call', callId: 'c2', deadline: 9999, request: fullRequest as never },
  { v: 1, kind: 'cancel', callId: 'c1' },
  { v: 1, kind: 'ping', at: 5 },
  { v: 1, kind: 'pong', at: 5 },
];

describe('frames codec — round trips', () => {
  for (const frame of nodeFrames) {
    it(`node frame ${frame.kind} round-trips`, () => {
      const out = decodeNodeFrame(encodeFrame(frame));
      expect(out).toEqual({ ok: true, frame });
    });
  }
  for (const frame of serverFrames) {
    it(`server frame ${frame.kind} round-trips`, () => {
      const out = decodeServerFrame(encodeFrame(frame));
      expect(out).toEqual({ ok: true, frame });
    });
  }
  it('pair_request round-trips', () => {
    const f: AnyNodeFrame = {
      v: 1,
      kind: 'pair_request',
      name: 'laptop',
      roots: [{ path: '/a', readOnly: true }],
    };
    expect(decodePairClientFrame(encodeFrame(f))).toEqual({ ok: true, frame: f });
  });
  // Verification m4: the unauthenticated pair_request must not carry an unbounded roots list.
  it('pair_request refuses more than 32 roots or a root path over 1024 chars', () => {
    const mk = (roots: unknown) =>
      JSON.stringify({ v: 1, kind: 'pair_request', name: 'laptop', roots });
    const root = (path: string) => ({ path, readOnly: false });
    const many = Array.from({ length: 32 }, (_, i) => root(`/r${i}`));
    expect(decodePairClientFrame(mk(many)).ok).toBe(true);
    expect(decodePairClientFrame(mk([...many, root('/extra')])).ok).toBe(false);
    expect(decodePairClientFrame(mk([root(`/${'a'.repeat(1023)}`)])).ok).toBe(true);
    expect(decodePairClientFrame(mk([root(`/${'a'.repeat(1024)}`)])).ok).toBe(false);
  });
  for (const f of [
    { v: 1, kind: 'pair_pending', code: 'ABCD2345', expiresAt: 10 },
    { v: 1, kind: 'pair_approved', key: 'sk-ethos-x', keyId: 'k1' },
    { v: 1, kind: 'pair_refused', reason: 'expired' },
  ] satisfies AnyNodeFrame[]) {
    it(`${f.kind} round-trips`, () => {
      expect(decodePairServerFrame(encodeFrame(f))).toEqual({ ok: true, frame: f });
    });
  }
});

describe('frames codec — refusals', () => {
  const hello = {
    v: 1,
    kind: 'hello',
    name: 'n',
    roots: [],
    tools: [],
    personalities: [],
    clock: 1,
  };
  const call = { v: 1, kind: 'call', callId: 'c', deadline: 1, request };

  it('refuses unknown v (2, missing, "1")', () => {
    for (const v of [2, undefined, '1']) {
      expect(decodeNodeFrame(JSON.stringify({ ...hello, v })).ok).toBe(false);
      expect(decodeServerFrame(JSON.stringify({ ...call, v })).ok).toBe(false);
    }
  });
  it('refuses unknown kind', () => {
    expect(decodeNodeFrame(JSON.stringify({ v: 1, kind: 'exec' })).ok).toBe(false);
    expect(decodeServerFrame(JSON.stringify({ v: 1, kind: 'exec' })).ok).toBe(false);
  });
  it('refuses a server frame on the node decoder and vice versa', () => {
    expect(decodeServerFrame(JSON.stringify(hello)).ok).toBe(false);
    expect(decodeNodeFrame(JSON.stringify(call)).ok).toBe(false);
    expect(decodePairClientFrame(JSON.stringify(hello)).ok).toBe(false);
    expect(decodePairServerFrame(JSON.stringify(hello)).ok).toBe(false);
  });
  it('refuses a callId longer than 128 chars on call and cancel frames', () => {
    const long = 'c'.repeat(129);
    const okId = 'c'.repeat(128);
    const callWith = (callId: string) =>
      JSON.stringify({ v: 1, kind: 'call', callId, deadline: 1, request });
    expect(decodeServerFrame(callWith(long)).ok).toBe(false);
    expect(decodeServerFrame(callWith(okId)).ok).toBe(true);
    expect(decodeServerFrame(JSON.stringify({ v: 1, kind: 'cancel', callId: long })).ok).toBe(
      false,
    );
  });
  it('refuses a numeric callId', () => {
    expect(decodeServerFrame(JSON.stringify({ v: 1, kind: 'cancel', callId: 7 })).ok).toBe(false);
    expect(
      decodeNodeFrame(JSON.stringify({ v: 1, kind: 'progress', callId: 7, message: 'm' })).ok,
    ).toBe(false);
  });
  it('refuses an oversize frame, measured in bytes', () => {
    // Multi-byte chars: string length is under the cap, byte length is over it.
    const big = '€'.repeat(Math.ceil(NODE_FRAME_MAX_BYTES / 3) + 1);
    expect(big.length).toBeLessThan(NODE_FRAME_MAX_BYTES);
    const text = JSON.stringify({ v: 1, kind: 'progress', callId: 'c', message: big });
    expect(Buffer.byteLength(text)).toBeGreaterThan(NODE_FRAME_MAX_BYTES);
    expect(decodeNodeFrame(text).ok).toBe(false);
  });
  it('refuses non-JSON', () => {
    expect(decodeNodeFrame('not json').ok).toBe(false);
    expect(decodeServerFrame('').ok).toBe(false);
    expect(decodeServerFrame('[1]').ok).toBe(false);
  });
  it('refuses a call whose request is malformed', () => {
    const { toolCallId: _drop, ...noId } = request;
    for (const bad of [
      noId,
      { ...request, currentTurn: '1' },
      { ...request, roomAudience: 'public' },
      { ...request, initiator: 'robot' },
      { ...request, toolsetNarrowing: { narrow: [1] } },
    ]) {
      expect(decodeServerFrame(JSON.stringify({ ...call, request: bad })).ok).toBe(false);
    }
  });
  it('refuses a result with a non-ToolResult code', () => {
    const f = {
      v: 1,
      kind: 'result',
      callId: 'c',
      result: { ok: false, code: 'node_disconnected', error: 'x' },
    };
    expect(decodeNodeFrame(JSON.stringify(f)).ok).toBe(false);
    expect(decodeToolResult({ ok: false, code: 'node_disconnected', error: 'x' })).toBeNull();
  });
});

describe('frames codec — shape', () => {
  it('drops unknown fields on a valid frame', () => {
    const text = JSON.stringify({ v: 1, kind: 'ping', at: 3, extra: 'x' });
    expect(decodeNodeFrame(text)).toEqual({ ok: true, frame: { v: 1, kind: 'ping', at: 3 } });
    const call = JSON.stringify({
      v: 1,
      kind: 'call',
      callId: 'c',
      deadline: 1,
      surprise: true,
      request: { ...request, extra: 1 },
    });
    const out = decodeServerFrame(call);
    expect(out.ok).toBe(true);
    if (out.ok && out.frame.kind === 'call') {
      expect(out.frame).toEqual({ v: 1, kind: 'call', callId: 'c', deadline: 1, request });
    }
  });
  it('keeps progress audience user as user (the proxy downgrades it, not the codec)', () => {
    const out = decodeNodeFrame(
      JSON.stringify({ v: 1, kind: 'progress', callId: 'c', message: 'm', audience: 'user' }),
    );
    expect(out).toEqual({
      ok: true,
      frame: { v: 1, kind: 'progress', callId: 'c', message: 'm', audience: 'user' },
    });
  });
  it('decodeToolExecuteRequest returns null for non-objects', () => {
    expect(decodeToolExecuteRequest(null)).toBeNull();
    expect(decodeToolExecuteRequest('x')).toBeNull();
  });
});
