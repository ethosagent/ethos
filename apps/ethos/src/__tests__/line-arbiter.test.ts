// `ethos chat` has several prompts that each read one line from the same
// readline session — tool approval, clarify, quick-command consent, masked
// credential read. Each used its own `rl.once('line')`, so with two open, one
// typed line answered both: a `y` meant for the clarify also allowed the
// approval. They now claim the line through one `LineArbiter`
// (lib/line-arbiter.ts): the prompt shown first gets the first line, the next
// one is shown only after.

import { EventEmitter } from 'node:events';
import type { BridgeApprovalRequest, BridgeApprovalSource } from '@ethosagent/agent-bridge';
import { describe, expect, it } from 'vitest';
import { attachCliApprovalPrompt } from '../lib/cli-approval-prompt';
import { createLineArbiter } from '../lib/line-arbiter';

class FakeReadline extends EventEmitter {
  setPrompt(): void {}
  prompt(): void {}
  type(line: string): void {
    this.emit('line', line);
  }
}

function fakeApprovalSource() {
  let onRequest: ((r: BridgeApprovalRequest) => void) | undefined;
  let onSettled: ((id: string, d: 'allow' | 'deny', by: string) => void) | undefined;
  const decisions: Array<[string, 'allow' | 'deny']> = [];
  const source: BridgeApprovalSource = {
    onRequest: (listener) => {
      onRequest = listener;
      return () => {};
    },
    onSettled: (listener) => {
      onSettled = listener;
      return () => {};
    },
    decide: (id, decision) => {
      decisions.push([id, decision]);
      onSettled?.(id, decision, 'cli');
    },
  };
  const request = (approvalId: string): void =>
    onRequest?.({
      approvalId,
      toolName: 'terminal',
      reason: 'terminal requires explicit approval',
      argsPreview: 'ls',
    } as BridgeApprovalRequest);
  const settle = (approvalId: string, decision: 'allow' | 'deny'): void =>
    onSettled?.(approvalId, decision, 'timeout');
  return { source, request, settle, decisions };
}

function setup() {
  const rl = new FakeReadline();
  const lines = createLineArbiter(rl);
  const approvals = fakeApprovalSource();
  const screen: string[] = [];
  attachCliApprovalPrompt({
    source: approvals.source,
    rl,
    lines,
    write: (text) => {
      if (text.includes('approval needed')) screen.push('approval');
    },
    onOpen: () => {},
    onClose: () => {},
  });
  const clarifyAnswers: string[] = [];
  // The shape of chat.ts's clarify presenter: a claim whose `show` draws the question.
  const clarify = () =>
    lines.claim({
      show: () => screen.push('clarify'),
      onLine: (line) => clarifyAnswers.push(line),
    });
  return { rl, lines, approvals, screen, clarifyAnswers, clarify };
}

describe('LineArbiter — one prompt owns stdin at a time', () => {
  it('clarify first: the typed line answers only the clarify, then the approval is shown', () => {
    const { rl, approvals, screen, clarifyAnswers, clarify } = setup();
    clarify();
    approvals.request('a1');
    expect(screen).toEqual(['clarify']);

    rl.type('y');
    expect(clarifyAnswers).toEqual(['y']);
    expect(approvals.decisions).toEqual([]);
    expect(screen).toEqual(['clarify', 'approval']);

    rl.type('y');
    expect(approvals.decisions).toEqual([['a1', 'allow']]);
    expect(clarifyAnswers).toEqual(['y']);
  });

  it('approval first: the clarify answer does not silently deny it, and vice versa', () => {
    const { rl, approvals, screen, clarifyAnswers, clarify } = setup();
    approvals.request('a1');
    clarify();
    expect(screen).toEqual(['approval']);

    rl.type('y');
    expect(approvals.decisions).toEqual([['a1', 'allow']]);
    expect(clarifyAnswers).toEqual([]);
    expect(screen).toEqual(['approval', 'clarify']);

    rl.type('option 2');
    expect(clarifyAnswers).toEqual(['option 2']);
    expect(approvals.decisions).toEqual([['a1', 'allow']]);
  });

  it('an approval settled elsewhere while waiting is never shown', () => {
    const { rl, approvals, screen, clarifyAnswers, clarify } = setup();
    clarify();
    approvals.request('a1');
    approvals.settle('a1', 'deny');
    rl.type('an answer');
    expect(clarifyAnswers).toEqual(['an answer']);
    expect(screen).toEqual(['clarify']);
  });

  it('an owner released without a line hands the line to the next claim', () => {
    const { rl, approvals, screen, clarifyAnswers, clarify } = setup();
    const claim = clarify();
    approvals.request('a1');
    claim.release();
    expect(screen).toEqual(['clarify', 'approval']);
    rl.type('n');
    expect(approvals.decisions).toEqual([['a1', 'deny']]);
    expect(clarifyAnswers).toEqual([]);
  });

  it('busy() holds while any claim owns or waits for the line', () => {
    const { rl, lines, clarify, approvals } = setup();
    expect(lines.busy()).toBe(false);
    const claim = clarify();
    approvals.request('a1');
    expect(lines.busy()).toBe(true);
    claim.release();
    expect(lines.busy()).toBe(true);
    rl.type('y');
    expect(lines.busy()).toBe(false);
  });
});
