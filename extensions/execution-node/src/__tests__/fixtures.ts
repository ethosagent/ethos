/** Shared builders for the execution-node tests. Not a test file (no `.test.`), so vitest skips it. */
import type { ToolExecuteRequest } from '@ethosagent/types';
import type { CallFrame, HelloFrame, ServerToNodeFrame } from '../frames';
import type { NodeConnection } from '../node-hub';

/** The fake clock of the guard and client tests; a default `callFrame` deadline is a minute later. */
export const NOW = 1_000_000;

export function makeRequest(over: Partial<ToolExecuteRequest> = {}): ToolExecuteRequest {
  return {
    toolCallId: 'tc',
    name: 'read_file',
    args: { path: 'a' },
    sessionId: 's',
    sessionKey: 'k',
    platform: 'cli',
    workingDir: '/srv',
    personalityId: 'coder',
    roomAudience: 'private',
    initiator: 'user',
    currentTurn: 1,
    messageCount: 1,
    resultBudgetChars: 1000,
    ...over,
  };
}

export function makeHello(over: Partial<HelloFrame> = {}): HelloFrame {
  return {
    v: 1,
    kind: 'hello',
    name: 'lap',
    roots: [{ path: '/p', readOnly: false }],
    tools: ['read_file'],
    personalities: ['*'],
    clock: NOW,
    ...over,
  };
}

export interface FakeConn extends NodeConnection {
  sent: ServerToNodeFrame[];
  closed?: { code: number; reason: string };
}
export function fakeConn(): FakeConn {
  const c: FakeConn = {
    sent: [],
    send: (f) => {
      c.sent.push(f);
    },
    close: (code, reason) => {
      c.closed = { code, reason };
    },
  };
  return c;
}

let seq = 0;
/** A `call` frame; `callId` defaults to a fresh one, `deadline` to `NOW + 60 s`. */
export function callFrame(
  name: string,
  args: unknown,
  over: { callId?: string; deadline?: number; req?: Partial<ToolExecuteRequest> } = {},
): CallFrame {
  seq += 1;
  return {
    v: 1,
    kind: 'call',
    callId: over.callId ?? `call-${seq}`,
    deadline: over.deadline ?? NOW + 60_000,
    request: makeRequest({
      toolCallId: `tc-${seq}`,
      name,
      args,
      workingDir: '/server/only',
      resultBudgetChars: 100_000,
      ...over.req,
    }),
  };
}
