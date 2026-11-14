// @vitest-environment jsdom
//
// Deny-and-redirect (ux-1): the approval modal reveals hidden/bidi characters
// in the args it shows, and lets the user deny with a note that is sent as the
// `reason` of `rpc.tools.deny` (the server sanitizes and frames it:
// `ApprovalsService` in apps/web-api). Same jsdom harness as
// `approval-modal-focus.test.ts`.

import type { ApprovalRequest } from '@ethosagent/web-contracts';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rpc } from '../../rpc';
import { ApprovalModal } from '../chat/ApprovalModal';

vi.mock('../../rpc', () => ({
  rpc: {
    tools: { approve: vi.fn().mockResolvedValue({}), deny: vi.fn().mockResolvedValue({}) },
  },
}));

const base: ApprovalRequest = {
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

async function render(request: ApprovalRequest) {
  await act(async () => {
    root.render(createElement(ApprovalModal, { request }));
  });
}

function button(label: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === label,
  );
  if (!found) throw new Error(`no button "${label}"`);
  return found;
}

function hasButton(label: string): boolean {
  return Array.from(container.querySelectorAll('button')).some(
    (b) => b.textContent?.trim() === label,
  );
}

async function click(el: HTMLElement) {
  await act(async () => {
    el.click();
  });
}

async function typeNote(value: string) {
  const ta = container.querySelector('textarea');
  if (!ta) throw new Error('no textarea');
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    setter?.call(ta, value);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.mocked(rpc.tools.deny).mockClear();
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

describe('ApprovalModal: hidden-character reveal', () => {
  it('renders hidden characters visibly and warns', async () => {
    await render({ ...base, args: { command: 'ls‮ -la' } });
    expect(container.querySelector('.approval-modal-args')?.textContent).toContain('⟨U+202E⟩');
    expect(container.querySelector('.approval-modal-hidden')?.textContent).toBe(
      '1 hidden character(s) shown as ⟨U+…⟩ — what runs may differ from what you read.',
    );
  });

  it('shows no warning for clean args', async () => {
    await render(base);
    expect(container.querySelector('.approval-modal-hidden')).toBeNull();
  });
});

describe('ApprovalModal: deny and redirect', () => {
  it('sends the note as the deny reason', async () => {
    await render(base);
    await click(button('Deny and redirect…'));
    expect(document.activeElement).toBe(container.querySelector('textarea'));
    await typeNote('use staging');
    await click(button('Deny with note'));
    expect(rpc.tools.deny).toHaveBeenCalledWith({
      approvalId: 'ap1',
      clientId: expect.any(String),
      reason: 'use staging',
    });
  });

  it('disables Deny with note until the note has text, and Back restores Allow', async () => {
    await render(base);
    await click(button('Deny and redirect…'));
    expect(hasButton('Allow')).toBe(false);
    expect(container.querySelector('fieldset')).toBeNull();
    expect(button('Deny with note').disabled).toBe(true);
    await typeNote('   ');
    expect(button('Deny with note').disabled).toBe(true);
    await typeNote('x');
    expect(button('Deny with note').disabled).toBe(false);
    await click(button('Back'));
    expect(hasButton('Allow')).toBe(true);
    expect(container.querySelector('fieldset')).not.toBeNull();
    expect(container.querySelector('textarea')).toBeNull();
  });

  it('plain Deny still sends no reason', async () => {
    await render(base);
    await click(button('Deny'));
    expect(rpc.tools.deny).toHaveBeenCalledWith({
      approvalId: 'ap1',
      clientId: expect.any(String),
    });
  });
});
