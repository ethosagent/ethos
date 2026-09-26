/**
 * The TUI's tool-approval modal. The host's approval gate
 * (apps/ethos/src/terminal-approval.ts) reaches the TUI as a
 * `BridgeApprovalSource`, relayed by `AgentBridge.setApprovalSource`; the App
 * renders the head of the queue as `ApprovalModal`. `y` allows, `n` / Esc /
 * Enter deny, and a second request waits until the first is answered.
 *
 * Driven with a real AgentBridge and a real Ink render; the source is an
 * in-test stand-in for `createTerminalApprovalSource`.
 */

import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  AgentBridge,
  type BridgeApprovalRequest,
  type BridgeApprovalSource,
} from '@ethosagent/agent-bridge';
import {
  AgentLoop,
  DefaultPersonalityRegistry,
  DefaultToolRegistry,
  InMemorySessionStore,
} from '@ethosagent/core';
import type { LLMProvider } from '@ethosagent/types';
import { render } from 'ink';
import { act, createElement } from 'react';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createTestSafety } from '../../../../packages/core/src/__tests__/helpers/test-safety';
import { App } from '../components/App';

class CapturingStdout extends EventEmitter {
  columns = 240;
  rows = 40;
  frames: string[] = [];
  write(chunk: string): boolean {
    this.frames.push(String(chunk));
    return true;
  }
  get last(): string {
    return this.frames.at(-1) ?? '';
  }
}

function makeStdin() {
  const s = new PassThrough() as PassThrough & {
    isTTY: boolean;
    setRawMode: () => void;
    ref: () => void;
    unref: () => void;
  };
  s.isTTY = true;
  s.setRawMode = () => {};
  s.ref = () => {};
  s.unref = () => {};
  return s;
}

/** A source whose requests the test raises and whose decisions it records. */
function fakeSource() {
  const emitter = new EventEmitter();
  const decisions: Array<{ approvalId: string; decision: 'allow' | 'deny' }> = [];
  const source: BridgeApprovalSource = {
    onRequest: (listener) => {
      emitter.on('request', listener);
      return () => emitter.off('request', listener);
    },
    onSettled: (listener) => {
      emitter.on('settled', listener);
      return () => emitter.off('settled', listener);
    },
    decide: (approvalId, decision) => {
      decisions.push({ approvalId, decision });
      emitter.emit('settled', approvalId, decision, 'tui');
    },
  };
  const request = (approvalId: string, command: string): void => {
    const req: BridgeApprovalRequest = {
      approvalId,
      toolName: 'terminal',
      reason: 'terminal requires explicit approval',
      argsPreview: JSON.stringify({ command }),
    };
    emitter.emit('request', req);
  };
  const settleElsewhere = (approvalId: string): void => {
    emitter.emit('settled', approvalId, 'deny', '__ethos_system__');
  };
  return { source, decisions, request, settleElsewhere };
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for: ${label}`);
}

const unmounts: Array<() => void> = [];
afterEach(() => {
  for (const u of unmounts.splice(0)) u();
});

// Every step that changes what the App renders runs inside React's `act`, which
// flushes the commit AND its passive effects before it returns. Without it a
// test could see the modal's frame on stdout before the modal's `useInput`
// effect had subscribed to Ink's input emitter: the App and InputBox already
// hold raw mode, so Ink reads a key the moment it is written and emits it to
// whoever is subscribed — a key written in that window never reached the modal,
// and under load the window was wide enough to lose `n`, Esc and Enter.
const actEnv = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
beforeAll(() => {
  actEnv.IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  delete actEnv.IS_REACT_ACT_ENVIRONMENT;
});

function mount() {
  const personalities = new DefaultPersonalityRegistry();
  personalities.define({ id: 'researcher', name: 'R', toolset: [] });
  // The loop never runs a turn here; requests come from the fake source.
  const loop = new AgentLoop({
    llm: { name: 'stub', model: 'stub-model' } as LLMProvider,
    tools: new DefaultToolRegistry(),
    personalities,
    session: new InMemorySessionStore(),
    safety: createTestSafety(),
  });
  const bridge = new AgentBridge(loop);
  const fake = fakeSource();
  bridge.setApprovalSource(fake.source);
  const stdout = new CapturingStdout();
  const stdin = makeStdin();
  const instance = render(
    createElement(App, {
      bridge,
      model: 'stub-model',
      initialPersonality: 'researcher',
      initialSessionKey: 'cli:tui-approval',
      readMemory: async () => null,
    }),
    {
      stdout: stdout as never,
      stdin: stdin as never,
      stderr: stdout as never,
      debug: true,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  );
  unmounts.push(() => instance.unmount());
  return { fake, stdout, stdin };
}

/** Mount, with the App's effects (its bridge subscription) flushed. In a real
 *  run a request only arrives mid-turn, long after mount. */
async function mounted() {
  let m: ReturnType<typeof mount> | undefined;
  await act(async () => {
    m = mount();
  });
  if (!m) throw new Error('mount did not run');
  const { fake, stdout, stdin } = m;
  /** Raise a request; resolves once the modal it opens is rendered and listening. */
  const request = (approvalId: string, command: string) =>
    act(async () => fake.request(approvalId, command));
  /** Settle a request elsewhere; resolves once the App has re-rendered. */
  const settleElsewhere = (approvalId: string) => act(async () => fake.settleElsewhere(approvalId));
  return { fake, stdout, stdin, request, settleElsewhere };
}

/** Write a key and flush what it causes. Ink reads stdin on `readable` (next
 *  tick) and holds a lone Esc ~20ms in case it starts an escape sequence, so
 *  the act scope stays open past both. */
const key = (stdin: PassThrough, data: string) =>
  act(async () => {
    stdin.write(data);
    await new Promise((r) => setTimeout(r, 50));
  });

describe('TUI — tool approval modal', () => {
  it('shows tool, reason and args, and "y" allows', async () => {
    const { fake, stdout, stdin, request } = await mounted();
    await request('a1', 'ls -la');
    await waitFor(() => stdout.last.includes('approval needed'), 'the modal rendered');
    expect(stdout.last).toContain('terminal');
    expect(stdout.last).toContain('terminal requires explicit approval');
    expect(stdout.last).toContain('ls -la');
    await key(stdin, 'y');
    await waitFor(() => fake.decisions.length === 1, 'a decision');
    expect(fake.decisions).toEqual([{ approvalId: 'a1', decision: 'allow' }]);
    await waitFor(() => !stdout.last.includes('approval needed'), 'the modal closed');
  });

  it.each([
    ['n', 'n'],
    ['Esc', '\u001b'],
    ['Enter', '\r'],
  ])('%s denies', async (_label, data) => {
    const { fake, stdout, stdin, request } = await mounted();
    await request('a1', 'ls -la');
    await waitFor(() => stdout.last.includes('approval needed'), 'the modal rendered');
    await key(stdin, data);
    await waitFor(() => fake.decisions.length === 1, 'a decision');
    expect(fake.decisions).toEqual([{ approvalId: 'a1', decision: 'deny' }]);
  });

  it('two requests are shown one after the other', async () => {
    const { fake, stdout, stdin, request } = await mounted();
    await request('a1', 'echo first');
    await request('a2', 'echo second');
    await waitFor(() => stdout.last.includes('echo first'), 'the first request');
    expect(stdout.last).not.toContain('echo second');
    expect(stdout.last).toContain('1 more waiting');
    await key(stdin, 'n');
    await waitFor(() => stdout.last.includes('echo second'), 'the second request');
    await key(stdin, 'y');
    await waitFor(() => fake.decisions.length === 2, 'two decisions');
    expect(fake.decisions).toEqual([
      { approvalId: 'a1', decision: 'deny' },
      { approvalId: 'a2', decision: 'allow' },
    ]);
  });

  it('a request settled elsewhere (timeout) closes the modal', async () => {
    const { fake, stdout, request, settleElsewhere } = await mounted();
    await request('a1', 'ls -la');
    await waitFor(() => stdout.last.includes('approval needed'), 'the modal rendered');
    await settleElsewhere('a1');
    await waitFor(() => !stdout.last.includes('approval needed'), 'the modal closed');
    expect(fake.decisions).toEqual([]);
  });
});
