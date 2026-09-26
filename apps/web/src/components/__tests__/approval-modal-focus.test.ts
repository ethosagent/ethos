// @vitest-environment jsdom
//
// W5 (ux-feedback plan) — the approval modal is an `alertdialog`, so it owns
// focus: the first control (the `once` scope radio) takes it on open, and the
// element the user was on gets it back when the modal closes. Without this a
// keyboard user was left focused on `body` under a modal they could not reach.
// Same jsdom + react-dom/client harness as `status-line.test.ts`.

import type { ApprovalRequest } from '@ethosagent/web-contracts';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApprovalModal } from '../chat/ApprovalModal';

vi.mock('../../rpc', () => ({
  rpc: {
    tools: { approve: vi.fn().mockResolvedValue({}), deny: vi.fn().mockResolvedValue({}) },
  },
}));

const request: ApprovalRequest = {
  approvalId: 'ap1',
  sessionId: 'sess-1',
  toolCallId: 'tc1',
  toolName: 'terminal',
  args: { command: 'rm -rf /tmp/x' },
  reason: 'recursive force-delete',
  alwaysAsk: false,
  hardline: false,
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
});

describe('ApprovalModal — focus management (useFocusTrap)', () => {
  it('moves focus to the first control on open and restores it on close', async () => {
    // Whatever had focus before the agent asked — the composer, usually.
    const before = document.createElement('button');
    before.textContent = 'composer';
    document.body.appendChild(before);
    before.focus();
    expect(document.activeElement).toBe(before);

    await act(async () => {
      root.render(createElement(ApprovalModal, { request }));
    });

    // The first focusable control is the `once` scope radio.
    const active = document.activeElement;
    expect(active).toBeInstanceOf(HTMLInputElement);
    expect(active instanceof HTMLInputElement ? active.value : null).toBe('once');

    // `approval.resolved` unmounts the modal; focus returns whence it came.
    await act(async () => {
      root.render(null);
    });
    expect(document.activeElement).toBe(before);
    before.remove();
  });
});
