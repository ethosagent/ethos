// @vitest-environment jsdom
//
// Communications > Rooms (plan/phases/channel-prompts-ui.md L5), against a
// mocked `rpc` — the observed-chats.test.ts pattern. `.test.ts` + createElement
// on purpose: the root vitest glob runs only `*.test.ts`, so a `.tsx` test would
// silently never run.

import type { RoomEntryView, RoomPlatform } from '@ethosagent/web-contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { act, createElement, type ReactNode } from 'react';
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

export const listFn = vi.fn();
export const setFn = vi.fn();
export const deleteFn = vi.fn();
export const previewFn = vi.fn();
export const recentFn = vi.fn();
export const platformSetFn = vi.fn();
export const skillsFn = vi.fn();
export const botsSlackFn = vi.fn();
export const personalitySkillsFn = vi.fn();
export const registryFn = vi.fn();

vi.mock('../../../rpc', () => ({
  rpc: {
    platforms: {
      listRoomPolicies: (...a: unknown[]) => listFn(...a),
      setRoomPolicy: (...a: unknown[]) => setFn(...a),
      deleteRoomPolicy: (...a: unknown[]) => deleteFn(...a),
      previewRoomPolicy: (...a: unknown[]) => previewFn(...a),
      listRecentRooms: (...a: unknown[]) => recentFn(...a),
      setRoomPlatformSettings: (...a: unknown[]) => platformSetFn(...a),
      botsListSlack: (...a: unknown[]) => botsSlackFn(...a),
    },
    personalities: { skillsList: (...a: unknown[]) => personalitySkillsFn(...a) },
    skills: { list: (...a: unknown[]) => skillsFn(...a) },
    modelRegistry: { list: (...a: unknown[]) => registryFn(...a) },
  },
}));

export const { RoomsSection } = await import('../RoomsSection');
export const { PREVIEW_DEBOUNCE_MS } = await import('../RoomDrawer');

export function entry(selector: string, over: Partial<RoomEntryView> = {}): RoomEntryView {
  return {
    selector,
    kind: 'room',
    fields: {},
    prompt: { text: '', chars: 0, source: null, path: null },
    source: 'config',
    version: `v-${selector}`,
    warnings: [],
    ...over,
  };
}

export function listResponse(
  platform: RoomPlatform,
  entries: RoomEntryView[],
  over: { fetchMetadata?: boolean; allowNameMatching?: boolean } = {},
) {
  return {
    platform,
    allowNameMatching: over.allowNameMatching ?? false,
    fetchMetadata: over.fetchMetadata ?? false,
    modes: [],
    entries,
    warnings: [],
  };
}

export function previewResponse(over: Record<string, unknown> = {}) {
  return {
    ok: true,
    platform: 'slack',
    chatId: 'C0DEPLOY',
    threadId: null,
    isDm: false,
    roomName: null,
    match: { key: 'C0DEPLOY', source: 'direct', layers: ['C0DEPLOY', '*'] },
    fields: {
      skills: null,
      model: null,
      tier: null,
      identity: true,
      metadata: false,
      silent: false,
      mode: null,
      modeKey: null,
    },
    promptLayers: [],
    digest: '3f9a1c2e',
    block: 'This channel coordinates deploys.',
    identityLineOmitted: true,
    warnings: [],
    ...over,
  };
}

export function rpcError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
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

export function tree(platform: RoomPlatform): ReactNode {
  return createElement(
    QueryClientProvider,
    { client } as { client: QueryClient; children?: ReactNode },
    createElement(AntApp, null, createElement(RoomsSection, { platform })),
  );
}

export async function mount(platform: RoomPlatform = 'slack'): Promise<void> {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  await act(async () => {
    root.render(tree(platform));
  });
  await flush();
}

export function byText(selector: string, text: string | RegExp, scope: ParentNode = document.body) {
  return (
    [...scope.querySelectorAll<HTMLElement>(selector)].find((el) =>
      typeof text === 'string' ? el.textContent?.trim() === text : text.test(el.textContent ?? ''),
    ) ?? null
  );
}

export function button(
  text: string | RegExp,
  scope: ParentNode = document.body,
): HTMLButtonElement {
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

export async function type(
  el: HTMLInputElement | HTMLTextAreaElement,
  value: string,
): Promise<void> {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

export async function choose(el: HTMLSelectElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(el, value);
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

export function field<T extends HTMLElement>(label: string): T {
  const l = byText('label', label);
  const id = l?.getAttribute('for');
  const el = id ? document.getElementById(id) : null;
  if (!el) throw new Error(`no field ${label}`);
  return el as T;
}

export function drawer(): HTMLElement | null {
  return document.body.querySelector('.rooms-drawer');
}

export function row(selector: string): HTMLElement {
  const el = document.body.querySelector<HTMLElement>(`[data-selector="${selector}"]`);
  if (!el) throw new Error(`no row ${selector}`);
  return el;
}

export async function openAdd(): Promise<void> {
  await click(button('Add room'));
}

export async function waitMs(ms: number): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
  await flush();
}

export function installRoomsHarness(): void {
  beforeEach(() => {
    vi.clearAllMocks();
    window.location.hash = '';
    listFn.mockImplementation(async ({ platform }: { platform: RoomPlatform }) =>
      listResponse(platform, []),
    );
    recentFn.mockResolvedValue({ rooms: [], omittedCount: 0 });
    previewFn.mockImplementation(async () => previewResponse());
    botsSlackFn.mockReset().mockResolvedValue({ bots: [] });
    personalitySkillsFn.mockReset().mockResolvedValue({ skills: [] });
    skillsFn.mockResolvedValue({
      skills: [
        { id: 'code-review', name: 'code-review' },
        { id: 'deploy-notes', name: 'deploy-notes' },
      ],
      pendingCount: 0,
    });
    registryFn.mockResolvedValue({
      entries: [{ alias: 'sonnet-main' }, { alias: 'haiku-cheap' }],
      default: null,
      roles: { trivial: null, default: null, deep: null, dreaming: null },
    });
    setFn.mockImplementation(async (input: { selector: string }) => ({
      ok: true,
      warnings: [],
      entry: entry(input.selector),
    }));
    deleteFn.mockResolvedValue({ ok: true, removed: true });
    platformSetFn.mockImplementation(async (input: { fetchMetadata: boolean }) => ({
      ok: true,
      fetchMetadata: input.fetchMetadata,
    }));
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

export function resetRoot(): void {
  root = createRoot(container);
}
