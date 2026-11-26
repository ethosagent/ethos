// @vitest-environment jsdom
//
// Shared mocks and helpers for the share-links web tests (plan
// phases/share-links.md Lane F). `.test.ts` + createElement on purpose: the root
// vitest glob runs only `*.test.ts`, so a `.tsx` test would never run.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { act, type ComponentProps, createElement, type ReactNode, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, vi } from 'vitest';

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

export const previewFn = vi.fn();
export const createFn = vi.fn();
export const listFn = vi.fn();
export const revokeFn = vi.fn();
export const writeText = vi.fn();

vi.mock('../../../rpc', () => ({
  rpc: {
    shares: {
      preview: (...a: unknown[]) => previewFn(...a),
      create: (...a: unknown[]) => createFn(...a),
      list: (...a: unknown[]) => listFn(...a),
      revoke: (...a: unknown[]) => revokeFn(...a),
    },
    sessions: {},
  },
}));

export const { ShareDialog, PREVIEW_DEBOUNCE_MS } = await import('../ShareDialog');
export const { SharedLinksSection } = await import('../SharedLinksSection');
export const { SessionContextMenu } = await import('../../../components/SessionContextMenu');

export const SESSION = { id: 'sess-1', title: 'Fix flaky retry test', personalityId: 'engineer' };
export const FAKE_TOKEN = 'Qm9yZWRQYW5kYUZvclRlc3RpbmdPbmx5MTIzNDU2Nzg5MA';

export function snapshot(over: { tools?: boolean } = {}) {
  return {
    ok: true as const,
    snapshot: {
      v: 1 as const,
      title: 'Fix flaky retry test',
      personalityId: 'engineer',
      createdAt: '2026-11-26T14:20:00.000Z',
      turns: [
        { role: 'user' as const, text: 'ping [REDACTED:email] about the spool' },
        {
          role: 'assistant' as const,
          text: 'Switched to jittered backoff.',
          ...(over.tools
            ? {
                tools: [
                  { name: 'run_tests', isError: false },
                  { name: 'write_file', isError: true },
                ],
              }
            : {}),
        },
      ],
    },
  };
}

export function created(over: { loopback?: boolean } = {}) {
  return {
    ok: true as const,
    url: `${over.loopback ? 'http://127.0.0.1:3000' : 'https://ethos.example.com'}/share/${FAKE_TOKEN}`,
    prefix: FAKE_TOKEN.slice(0, 8),
    expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    loopback: over.loopback ?? false,
  };
}

export function link(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    prefix: `${id}-pfx`.slice(0, 8),
    sessionId: 'sess-1',
    title: `Title ${id}`,
    createdAt: '2026-11-26T14:20:00.000Z',
    expiresAt: '2026-12-03T14:20:00.000Z',
    viewCount: 3,
    lastViewedAt: '2026-11-27T09:02:00.000Z',
    revokedAt: null,
    ...over,
  };
}

export let container: HTMLDivElement;
export let root: Root;
export let client: QueryClient;

export async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

export async function waitMs(ms: number): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
  await flush();
}

export async function mountNode(node: ReactNode): Promise<void> {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client } as { client: QueryClient; children?: ReactNode },
        createElement(AntApp, null, node),
      ),
    );
  });
  await flush();
}

// Mounts the dialog the way its openers do: only while open, so closing unmounts it.
function DialogHost({
  onClose,
  session,
}: {
  onClose: () => void;
  session: ComponentProps<typeof ShareDialog>['session'];
}): ReactNode {
  const [open, setOpen] = useState(true);
  if (!open) return null;
  return createElement(ShareDialog, {
    session,
    onClose: () => {
      onClose();
      setOpen(false);
    },
  });
}

export function mountDialog(
  onClose: () => void = () => {},
  session: ComponentProps<typeof ShareDialog>['session'] = SESSION,
): Promise<void> {
  return mountNode(createElement(DialogHost, { onClose, session }));
}

export function byText(selector: string, text: string | RegExp, scope: ParentNode = document.body) {
  return (
    [...scope.querySelectorAll<HTMLElement>(selector)].find((el) =>
      typeof text === 'string' ? el.textContent?.trim() === text : text.test(el.textContent ?? ''),
    ) ?? null
  );
}

export function button(text: string | RegExp, scope: ParentNode = document.body) {
  const el = byText('button', text, scope);
  if (!el) throw new Error(`no button ${String(text)}`);
  return el as HTMLButtonElement;
}

export async function click(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  await flush();
}

export function input(id: string): HTMLInputElement {
  const el = document.getElementById(id);
  if (!(el instanceof HTMLInputElement)) throw new Error(`no input #${id}`);
  return el;
}

export async function choose(el: HTMLSelectElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(el, value);
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

export function text(): string {
  return document.body.textContent ?? '';
}

export function installShareHarness(): void {
  beforeEach(() => {
    vi.clearAllMocks();
    previewFn.mockImplementation(async (i: { includeToolNames: boolean }) =>
      snapshot({ tools: i.includeToolNames }),
    );
    createFn.mockImplementation(async () => created());
    listFn.mockResolvedValue({ enabled: true, links: [] });
    revokeFn.mockResolvedValue({ ok: true });
    writeText.mockReset().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    document.body.innerHTML = '';
  });
}
