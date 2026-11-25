// @vitest-environment jsdom
//
// MessagingStep › "Give a channel its own instructions →" (plan
// channel-prompts-ui.md §3.7, L6). The link is optional and appears only once a
// Slack, Discord or Telegram token has been accepted (`ok` or `unreachable`).
// It must not gate Continue.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }),
});
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const validateFn = vi.fn();
const setFn = vi.fn();
const stateFn = vi.fn();

vi.mock('../../rpc', () => ({
  rpc: {
    onboarding: { state: (...a: unknown[]) => stateFn(...a) },
    platforms: {
      validate: (...a: unknown[]) => validateFn(...a),
      set: (...a: unknown[]) => setFn(...a),
    },
  },
}));

const { MessagingStep } = await import('../steps/MessagingStep');

const LINK_TEXT = 'Give a channel its own instructions';

let container: HTMLElement;
let root: Root;

async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

async function mount() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client: qc },
        createElement(
          MemoryRouter,
          null,
          createElement(MessagingStep, { answers: {} as never, onNext: () => {} }),
        ),
      ),
    );
  });
  await flush();
  // Default is "skip"; open the setup form.
  const setup = container.querySelector<HTMLInputElement>(
    'input[name="messaging-choice"][value="setup"]',
  );
  await act(async () => setup?.click());
}

beforeEach(async () => {
  validateFn.mockReset();
  setFn.mockReset().mockResolvedValue(undefined);
  stateFn.mockReset().mockResolvedValue({ step: 'done' });
  await mount();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function pickPlatform(id: string) {
  const radio = container.querySelector<HTMLInputElement>(`input[name="platform"][value="${id}"]`);
  await act(async () => radio?.click());
}

async function fillAll() {
  const inputs = Array.from(container.querySelectorAll<HTMLInputElement>('input[id^="msg-"]'));
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  for (const input of inputs) {
    await act(async () => {
      setter?.call(input, 'x');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }
}

async function validate() {
  const btn = Array.from(container.querySelectorAll('button')).find((b) =>
    /Validate|Save/.test(b.textContent ?? ''),
  );
  await act(async () => btn?.click());
  await flush();
}

function roomsLink(): HTMLAnchorElement | undefined {
  return Array.from(container.querySelectorAll('a')).find((a) =>
    a.textContent?.includes(LINK_TEXT),
  );
}

function continueButton(): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find((b) =>
    /Continue/.test(b.textContent ?? ''),
  );
}

describe('MessagingStep rooms link', () => {
  it('is absent before any validation', async () => {
    await fillAll();
    expect(roomsLink()).toBeUndefined();
  });

  for (const status of ['ok', 'unreachable'] as const) {
    for (const id of ['telegram', 'discord', 'slack']) {
      it(`appears for ${id} when the token is ${status}, with the rooms deep link`, async () => {
        validateFn.mockResolvedValue(
          status === 'ok' ? { status: 'ok', label: 'bot', error: null } : { status },
        );
        await pickPlatform(id);
        await fillAll();
        await validate();
        const link = roomsLink();
        expect(link).toBeDefined();
        expect(link?.getAttribute('href')).toBe(`/communications?tab=${id}#rooms`);
        expect(continueButton()?.disabled).toBe(false);
      });
    }
  }

  it('is not offered during first-run (the redirect would bounce it back)', async () => {
    await act(async () => root.unmount());
    container.remove();
    stateFn.mockResolvedValue({ step: 'personality' });
    await mount();
    validateFn.mockResolvedValue({ status: 'ok', label: 'bot', error: null });
    await pickPlatform('slack');
    await fillAll();
    await validate();
    await flush();
    expect(container.textContent).toContain('Connected');
    expect(roomsLink()).toBeUndefined();
    expect(continueButton()?.disabled).toBe(false);
  });

  it('is absent when the token is rejected', async () => {
    validateFn.mockResolvedValue({ status: 'rejected', error: 'nope' });
    await fillAll();
    await validate();
    expect(roomsLink()).toBeUndefined();
    expect(continueButton()?.disabled).toBe(true);
  });

  it('is absent for email after save', async () => {
    await pickPlatform('email');
    await fillAll();
    await validate();
    expect(setFn).toHaveBeenCalled();
    expect(container.textContent).toContain('Saved');
    expect(roomsLink()).toBeUndefined();
  });
});
