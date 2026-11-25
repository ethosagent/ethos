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

const listFn = vi.fn();
const setFn = vi.fn();
const deleteFn = vi.fn();
const previewFn = vi.fn();
const recentFn = vi.fn();
const platformSetFn = vi.fn();
const skillsFn = vi.fn();
const botsSlackFn = vi.fn();
const personalitySkillsFn = vi.fn();
const registryFn = vi.fn();

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

const { RoomsSection } = await import('../RoomsSection');
const { PREVIEW_DEBOUNCE_MS } = await import('../RoomDrawer');

function entry(selector: string, over: Partial<RoomEntryView> = {}): RoomEntryView {
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

function listResponse(
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

function previewResponse(over: Record<string, unknown> = {}) {
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

function rpcError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

let container: HTMLDivElement;
let root: Root;
let client: QueryClient;

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function tree(platform: RoomPlatform): ReactNode {
  return createElement(
    QueryClientProvider,
    { client } as { client: QueryClient; children?: ReactNode },
    createElement(AntApp, null, createElement(RoomsSection, { platform })),
  );
}

async function mount(platform: RoomPlatform = 'slack'): Promise<void> {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  await act(async () => {
    root.render(tree(platform));
  });
  await flush();
}

function byText(selector: string, text: string | RegExp, scope: ParentNode = document.body) {
  return (
    [...scope.querySelectorAll<HTMLElement>(selector)].find((el) =>
      typeof text === 'string' ? el.textContent?.trim() === text : text.test(el.textContent ?? ''),
    ) ?? null
  );
}

function button(text: string | RegExp, scope: ParentNode = document.body): HTMLButtonElement {
  const el = byText('button', text, scope);
  if (!el) throw new Error(`no button ${String(text)}`);
  return el as HTMLButtonElement;
}

async function click(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  await flush();
}

async function type(el: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function choose(el: HTMLSelectElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(el, value);
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

function field<T extends HTMLElement>(label: string): T {
  const l = byText('label', label);
  const id = l?.getAttribute('for');
  const el = id ? document.getElementById(id) : null;
  if (!el) throw new Error(`no field ${label}`);
  return el as T;
}

function drawer(): HTMLElement | null {
  return document.body.querySelector('.rooms-drawer');
}

function row(selector: string): HTMLElement {
  const el = document.body.querySelector<HTMLElement>(`[data-selector="${selector}"]`);
  if (!el) throw new Error(`no row ${selector}`);
  return el;
}

async function openAdd(): Promise<void> {
  await click(button('Add room'));
}

async function waitMs(ms: number): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
  await flush();
}

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

describe('Rooms table', () => {
  it('lists the pinned rows first, then entries with chips, counter and source', async () => {
    listFn.mockResolvedValue(
      listResponse('slack', [
        entry('C0DEPLOY', {
          fields: { mode: 'thread_follow', skills: ['code-review'], tier: 'deep' },
          prompt: { text: 'x'.repeat(2140), chars: 2140, source: 'file', path: 'p' },
          source: 'both',
        }),
        entry('*', { kind: 'rooms', fields: { silent: true } }),
      ]),
    );
    await mount('slack');

    const rows = [...document.body.querySelectorAll('[data-selector]')].map((r) =>
      r.getAttribute('data-selector'),
    );
    expect(rows).toEqual(['*', '*dm', 'C0DEPLOY']);
    expect(row('*').textContent).toContain('All channels');
    expect(row('*dm').textContent).toContain('All DMs');
    expect(row('*dm').textContent).toContain('not set');
    const deploy = row('C0DEPLOY').textContent ?? '';
    expect(deploy).toContain('thread_follow');
    expect(deploy).toContain('code-review');
    expect(deploy).toContain('tier: deep');
    expect(deploy).toContain('2,140 / 4,000');
    expect(deploy).toContain('file + config');
    expect(row('*').textContent).toContain('silent');
  });

  it('shows the empty state copy and keeps the pinned rows', async () => {
    await mount('slack');
    expect(document.body.textContent).toContain('No room rules for Slack.');
    expect(document.body.textContent).toContain(
      'Every room uses the personality as-is. Add a room to give one channel its own instructions.',
    );
    expect(document.body.querySelectorAll('[data-selector]').length).toBe(2);
  });

  it('labels the pinned rows "All groups" on Telegram', async () => {
    await mount('telegram');
    expect(row('*').textContent).toContain('All groups');
    expect(document.body.textContent).toContain('No room rules for Telegram.');
  });

  it('shows a row warning beside the entry', async () => {
    listFn.mockResolvedValue(
      listResponse('slack', [entry('C0SUPPORT', { warnings: ["model 'fast' is not an alias"] })]),
    );
    await mount('slack');
    expect(row('C0SUPPORT').textContent).toContain("model 'fast' is not an alias");
  });
});

describe('Add and edit', () => {
  it('add -> save sends expectedVersion null and shows the restart notice', async () => {
    await mount('slack');
    await openAdd();
    await type(field<HTMLInputElement>('Channel ID'), 'C0DEPLOY');
    await type(field<HTMLTextAreaElement>('Room prompt'), 'Confirm service first.');
    await click(button('Save'));

    expect(setFn).toHaveBeenCalledTimes(1);
    expect(setFn).toHaveBeenCalledWith({
      platform: 'slack',
      selector: 'C0DEPLOY',
      entry: { prompt: 'Confirm service first.' },
      expectedVersion: null,
    });
    expect(drawer()).toBeNull();
    const status = document.body.querySelector('[data-testid="rooms-restart-notice"]');
    expect(status?.textContent).toContain('Saved. Restart the gateway to apply.');
    expect(status?.textContent).toContain('gateway restart');
    // No restart button in v1 (plan D17).
    expect(byText('button', /restart/i)).toBeNull();
    // The list was refetched.
    expect(listFn.mock.calls.length).toBeGreaterThan(1);
  });

  it('edit sends the version the row carried', async () => {
    listFn.mockResolvedValue(
      listResponse('slack', [
        entry('C0DEPLOY', {
          version: 'abc123',
          fields: { mode: 'all' },
          prompt: { text: 'hello', chars: 5, source: 'file', path: 'p' },
        }),
      ]),
    );
    await mount('slack');
    await click(button('Edit', row('C0DEPLOY')));

    expect(field<HTMLTextAreaElement>('Room prompt').value).toBe('hello');
    expect(field<HTMLInputElement>('Channel ID').value).toBe('C0DEPLOY');
    expect(field<HTMLInputElement>('Channel ID').readOnly).toBe(true);
    await click(button('Save'));
    expect(setFn).toHaveBeenCalledWith({
      platform: 'slack',
      selector: 'C0DEPLOY',
      entry: { prompt: 'hello', mode: 'all' },
      expectedVersion: 'abc123',
    });
  });

  it('a pinned row with no entry opens with its wildcard fixed', async () => {
    await mount('slack');
    await click(button('Set', row('*dm')));
    expect(field<HTMLInputElement>('Channel ID').value).toBe('*dm');
    await click(button('Save'));
    expect(setFn.mock.calls[0]?.[0]).toMatchObject({ selector: '*dm', expectedVersion: null });
  });

  it('model and tier are one choice: picking a tier sends tier only', async () => {
    await mount('slack');
    await openAdd();
    await type(field<HTMLInputElement>('Channel ID'), 'C0DEPLOY');
    await choose(field<HTMLSelectElement>('Model'), 'alias:sonnet-main');
    await choose(field<HTMLSelectElement>('Model'), 'tier:deep');
    await click(button('Save'));
    expect(setFn.mock.calls[0]?.[0].entry).toEqual({ prompt: '', tier: 'deep' });
  });

  it('a mode picked from the select is sent', async () => {
    await mount('slack');
    await openAdd();
    await type(field<HTMLInputElement>('Channel ID'), 'C0DEPLOY');
    await choose(field<HTMLSelectElement>('Mode'), 'observe');
    expect(document.body.textContent).toContain('Reads, never answers (digest only).');
    await click(button('Save'));
    expect(setFn.mock.calls[0]?.[0].entry).toEqual({ prompt: '', mode: 'observe' });
  });

  it('Esc closes the drawer', async () => {
    await mount('slack');
    await openAdd();
    expect(drawer()).not.toBeNull();
    const target = field<HTMLInputElement>('Channel ID');
    await act(async () => {
      target.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }),
      );
    });
    await waitMs(400);
    expect(document.body.querySelector('.ant-drawer-open')).toBeNull();
  });
});

describe('Errors and validation', () => {
  it('409 shows the conflict copy and re-fetches the list', async () => {
    listFn.mockResolvedValue(listResponse('slack', [entry('C0DEPLOY', { version: 'old' })]));
    setFn.mockRejectedValueOnce(rpcError('CONFIG_CONFLICT', 'expectedVersion old is stale'));
    await mount('slack');
    const before = listFn.mock.calls.length;
    listFn.mockResolvedValue(listResponse('slack', [entry('C0DEPLOY', { version: 'fresh' })]));
    await click(button('Edit', row('C0DEPLOY')));
    await click(button('Save'));

    expect(drawer()?.textContent).toContain('Changed elsewhere');
    expect(drawer()?.textContent).toContain('reloaded');
    expect(listFn.mock.calls.length).toBeGreaterThan(before);
    // The next save carries the fresh version.
    await click(button('Save'));
    expect(setFn).toHaveBeenLastCalledWith(expect.objectContaining({ expectedVersion: 'fresh' }));
  });

  it("offers a bound bot personality's skills, so they are not flagged as unknown", async () => {
    botsSlackFn.mockResolvedValue({
      bots: [{ botKey: 'k', bind: { type: 'personality', name: 'ops' } }],
    });
    personalitySkillsFn.mockResolvedValue({ skills: [{ id: 'bot-only-skill' }] });
    listFn.mockResolvedValue(
      listResponse('slack', [
        entry('C0DEPLOY', { fields: { skills: ['bot-only-skill', 'nope'] } }),
      ]),
    );
    await mount('slack');
    await click(button('Edit', row('C0DEPLOY')));
    expect(personalitySkillsFn).toHaveBeenCalledWith({ personalityId: 'ops' });
    const text = drawer()?.textContent ?? '';
    expect(text).toContain('Not an installed skill: nope.');
    expect(text).not.toContain('bot-only-skill.');
  });

  it('partial shows which half landed and Retry resends the identical request', async () => {
    setFn.mockResolvedValueOnce({
      ok: false,
      reason: 'partial',
      fileWritten: true,
      fileRemoved: false,
      configWritten: false,
      cause: 'config.yaml write failed: EACCES',
    });
    await mount('slack');
    await openAdd();
    await type(field<HTMLInputElement>('Channel ID'), 'C0DEPLOY');
    await type(field<HTMLTextAreaElement>('Room prompt'), 'hi');
    await click(button('Save'));

    const text = drawer()?.textContent ?? '';
    expect(text).toContain('prompt file was written');
    expect(text).toContain('config.yaml was not updated');
    expect(text).toContain('EACCES');
    // Typing now must not change what Retry sends.
    await type(field<HTMLTextAreaElement>('Room prompt'), 'hi, edited after');
    await click(button('Retry'));
    expect(setFn).toHaveBeenCalledTimes(2);
    expect(setFn.mock.calls[1]?.[0]).toEqual(setFn.mock.calls[0]?.[0]);
    expect(document.body.querySelector('[data-testid="rooms-restart-notice"]')).not.toBeNull();
  });

  it('partial after a blank prompt removed the file says removed, not not written', async () => {
    setFn.mockResolvedValueOnce({
      ok: false,
      reason: 'partial',
      fileWritten: false,
      fileRemoved: true,
      configWritten: false,
      cause: 'config.yaml write failed: EACCES',
    });
    await mount('slack');
    await openAdd();
    await type(field<HTMLInputElement>('Channel ID'), 'C0DEPLOY');
    await click(button('Save'));
    const text = drawer()?.textContent ?? '';
    expect(text).toContain('prompt file was removed');
    expect(text).not.toContain('was not written');
  });

  it('a delete that lands in part offers Retry with the same request', async () => {
    listFn.mockResolvedValue(listResponse('slack', [entry('C0DEPLOY', { version: 'v9' })]));
    deleteFn.mockResolvedValueOnce({
      ok: false,
      reason: 'partial',
      fileRemoved: true,
      configRemoved: false,
      cause: 'EACCES',
    });
    await mount('slack');
    await click(button('Edit', row('C0DEPLOY')));
    await click(button('Delete'));
    await click(button('Confirm delete'));
    expect(drawer()?.textContent).toContain('prompt file was removed');
    await click(button('Retry'));
    expect(deleteFn).toHaveBeenCalledTimes(2);
    expect(deleteFn.mock.calls[1]?.[0]).toEqual(deleteFn.mock.calls[0]?.[0]);
  });

  it('over 4,000 characters disables Save and says by how much', async () => {
    await mount('slack');
    await openAdd();
    await type(field<HTMLInputElement>('Channel ID'), 'C0DEPLOY');
    await type(field<HTMLTextAreaElement>('Room prompt'), 'x'.repeat(4001));
    expect(drawer()?.textContent).toContain('4,001 / 4,000');
    expect(button('Save').disabled).toBe(true);
    await type(field<HTMLTextAreaElement>('Room prompt'), 'x'.repeat(4000));
    expect(button('Save').disabled).toBe(false);
  });

  it('a 413 from the server is shown and nothing is claimed saved', async () => {
    setFn.mockRejectedValueOnce(
      rpcError('PAYLOAD_TOO_LARGE', 'Prompt is 4,213 chars after template-token sanitising'),
    );
    await mount('slack');
    await openAdd();
    await type(field<HTMLInputElement>('Channel ID'), 'C0DEPLOY');
    await click(button('Save'));
    expect(drawer()?.textContent).toContain('4,213 chars');
    expect(document.body.querySelector('[data-testid="rooms-restart-notice"]')).toBeNull();
  });

  it('an unusual but path-safe id warns and still saves', async () => {
    await mount('slack');
    await openAdd();
    await type(field<HTMLInputElement>('Channel ID'), 'c0deploy');
    expect(drawer()?.textContent).toContain('does not look like a Slack channel id');
    expect(button('Save').disabled).toBe(false);
    await click(button('Save'));
    expect(setFn).toHaveBeenCalledTimes(1);
  });

  it('a path-unsafe id is refused inline and blocks Save', async () => {
    await mount('slack');
    await openAdd();
    await type(field<HTMLInputElement>('Channel ID'), 'C0/X');
    expect(drawer()?.querySelector('[role="alert"]')?.textContent).toContain("cannot contain '/'");
    expect(button('Save').disabled).toBe(true);
  });

  it('a server refusal in the preview blocks Save; server warnings stay savable', async () => {
    previewFn.mockRejectedValue(
      rpcError('INVALID_INPUT', "channels.slack.C0DEPLOY.mode: 'bogus' is not a reply mode"),
    );
    await mount('slack');
    await openAdd();
    await type(field<HTMLInputElement>('Channel ID'), 'C0DEPLOY');
    await waitMs(PREVIEW_DEBOUNCE_MS + 100);
    expect(drawer()?.textContent).toContain("'bogus' is not a reply mode");
    expect(button('Save').disabled).toBe(true);

    previewFn.mockImplementation(async () =>
      previewResponse({ warnings: ["skill 'zzz' not found for C0DEPLOY"] }),
    );
    await type(field<HTMLInputElement>('Channel ID'), 'C0DEPLOY2');
    await waitMs(PREVIEW_DEBOUNCE_MS + 100);
    expect(button('Save').disabled).toBe(false);
  });

  it('preview warnings: the template-token one shows, and Saved anyway is never doubled', async () => {
    previewFn.mockImplementation(async () =>
      previewResponse({
        warnings: [
          "Room id 'C0DEPLOY' does not look like a Slack channel id. Saved anyway.",
          "Template tokens in the prompt for 'C0DEPLOY' are stripped when the gateway loads it.",
        ],
      }),
    );
    await mount('slack');
    await openAdd();
    await type(field<HTMLInputElement>('Channel ID'), 'C0DEPLOY');
    await waitMs(PREVIEW_DEBOUNCE_MS + 100);
    const text = drawer()?.textContent ?? '';
    expect(text).toContain('Template tokens in the prompt');
    expect(text).not.toContain('Saved anyway. Saved anyway.');
    expect(text.match(/Saved anyway\./g)?.length).toBe(2);
  });

  it('a 400 on save shows the server sentence', async () => {
    setFn.mockRejectedValueOnce(rpcError('INVALID_INPUT', 'skill cannot contain a comma'));
    await mount('slack');
    await openAdd();
    await type(field<HTMLInputElement>('Channel ID'), 'C0DEPLOY');
    await click(button('Save'));
    expect(drawer()?.textContent).toContain('skill cannot contain a comma');
  });
});

describe('Delete', () => {
  it('is two steps in the page and never uses window.confirm', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm');
    listFn.mockResolvedValue(listResponse('slack', [entry('C0DEPLOY', { version: 'v7' })]));
    await mount('slack');
    await click(button('Edit', row('C0DEPLOY')));
    await click(button('Delete'));
    expect(deleteFn).not.toHaveBeenCalled();
    expect(drawer()?.textContent).toContain('Delete room C0DEPLOY?');
    expect(drawer()?.textContent).toContain('channels/slack/C0DEPLOY.md');
    await click(button('Confirm delete'));
    expect(deleteFn).toHaveBeenCalledWith({
      platform: 'slack',
      selector: 'C0DEPLOY',
      expectedVersion: 'v7',
    });
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(document.body.querySelector('[data-testid="rooms-restart-notice"]')).not.toBeNull();
  });

  it('is not offered for a room that has no entry yet', async () => {
    await mount('slack');
    await openAdd();
    expect(byText('button', 'Delete')).toBeNull();
  });
});

describe('Platform switch', () => {
  it('shows Fetch room metadata on Slack and Discord and writes it', async () => {
    for (const platform of ['slack', 'discord'] as const) {
      await mount(platform);
      const sw = document.body.querySelector<HTMLElement>('[aria-label="Fetch room metadata"]');
      expect(sw, platform).not.toBeNull();
      expect(sw?.getAttribute('aria-checked')).toBe('false');
      await click(sw as HTMLElement);
      expect(platformSetFn).toHaveBeenLastCalledWith({ platform, fetchMetadata: true });
      expect(document.body.querySelector('[data-testid="rooms-restart-notice"]')).not.toBeNull();
      await act(async () => root.unmount());
      root = createRoot(container);
    }
  });

  it('is hidden on Telegram and WhatsApp', async () => {
    for (const platform of ['telegram', 'whatsapp'] as const) {
      await mount(platform);
      expect(
        document.body.querySelector('[aria-label="Fetch room metadata"]'),
        platform,
      ).toBeNull();
      await act(async () => root.unmount());
      root = createRoot(container);
    }
  });

  it('shows name matching as read-only text with no control', async () => {
    await mount('slack');
    expect(document.body.textContent).toContain('Name matching: off');
    expect(document.body.textContent).toContain('config only');
    expect(document.body.querySelectorAll('[role="switch"]').length).toBe(1);
  });

  it('an unsupported or partial answer is shown, partial with Retry', async () => {
    platformSetFn.mockResolvedValueOnce({ ok: false, reason: 'partial', cause: 'EACCES' });
    await mount('slack');
    await click(document.body.querySelector('[aria-label="Fetch room metadata"]') as HTMLElement);
    expect(document.body.textContent).toContain('EACCES');
    await click(button('Retry'));
    expect(platformSetFn).toHaveBeenCalledTimes(2);
    expect(platformSetFn.mock.calls[1]?.[0]).toEqual(platformSetFn.mock.calls[0]?.[0]);
  });
});

describe('Telegram, Discord specifics', () => {
  it('the Telegram mode list excludes regex_match', async () => {
    await mount('telegram');
    await openAdd();
    const options = [...field<HTMLSelectElement>('Mode').options].map((o) => o.value);
    expect(options).toEqual(['', 'mention_only', 'thread_follow', 'all', 'observe']);
  });

  it('a Telegram topic is written nested under its room', async () => {
    await mount('telegram');
    await openAdd();
    await type(field<HTMLInputElement>('Group ID'), '-1001234567890');
    await type(field<HTMLInputElement>('Topic ID'), '99');
    await click(button('Save'));
    expect(setFn.mock.calls[0]?.[0].selector).toBe('-1001234567890.topics.99');
  });

  it('a Discord thread is written as the direct key', async () => {
    await mount('discord');
    await openAdd();
    await type(field<HTMLInputElement>('Channel ID'), '123456789012');
    await type(field<HTMLInputElement>('Thread ID'), '555666777888');
    await click(button('Save'));
    expect(setFn.mock.calls[0]?.[0].selector).toBe('555666777888');
  });

  it('Metadata is described with the platform switch state, disabled where unsupported', async () => {
    await mount('telegram');
    await openAdd();
    const sw = drawer()?.querySelector<HTMLButtonElement>('[aria-label="Metadata"]');
    expect(sw?.disabled).toBe(true);
    expect(drawer()?.textContent).toContain('not available on Telegram yet');
    await act(async () => root.unmount());
    root = createRoot(container);
    listFn.mockImplementation(async ({ platform }: { platform: RoomPlatform }) =>
      listResponse(platform, [], { fetchMetadata: true }),
    );
    await mount('slack');
    await openAdd();
    expect(drawer()?.textContent).toContain('Platform switch now: on');
  });
});

describe('Recent rooms', () => {
  it('lists ids with a DM flag, relative time and Add that prefills the drawer', async () => {
    const now = Date.now();
    recentFn.mockResolvedValue({
      rooms: [
        {
          chatId: 'C0OPS',
          isDm: false,
          lastActiveAt: new Date(now - 2 * 3_600_000).toISOString(),
          hasEntry: false,
        },
        {
          chatId: 'D0OWNER',
          isDm: true,
          lastActiveAt: new Date(now - 26 * 3_600_000).toISOString(),
          hasEntry: false,
        },
      ],
      omittedCount: 0,
    });
    await mount('slack');
    const text = document.body.textContent ?? '';
    expect(text).toContain('Recently active rooms');
    expect(text).toContain('C0OPS');
    expect(text).toContain('2h ago');
    expect(text).toContain('1d ago');
    expect(text).toContain('DM');
    expect(text).toContain('Ids only. Titles and message text are never listed.');

    const li = byText('li', /D0OWNER/);
    expect(li).not.toBeNull();
    await click(button('Add', li as HTMLElement));
    expect(field<HTMLInputElement>('Channel ID').value).toBe('D0OWNER');
    await click(button('Save'));
    expect(setFn.mock.calls[0]?.[0].selector).toBe('D0OWNER');
  });

  it('shows the empty copy', async () => {
    await mount('slack');
    expect(document.body.textContent).toContain(
      'No recent rooms. The list fills once the gateway has answered in a room.',
    );
  });
});

describe('Restart notice', () => {
  it('is component state: gone after a remount (D18)', async () => {
    await mount('slack');
    await openAdd();
    await type(field<HTMLInputElement>('Channel ID'), 'C0DEPLOY');
    await click(button('Save'));
    expect(document.body.querySelector('[data-testid="rooms-restart-notice"]')).not.toBeNull();

    await act(async () => root.unmount());
    root = createRoot(container);
    await mount('slack');
    expect(document.body.querySelector('[data-testid="rooms-restart-notice"]')).toBeNull();
    // The static header badge stays.
    expect(document.body.textContent).toContain('gateway restart');
  });
});

describe('Preview', () => {
  it('renders the block as text, with digest, chain and the three notes', async () => {
    previewFn.mockImplementation(async () =>
      previewResponse({ block: '<img src=x onerror=alert(1)><script>alert(2)</script>' }),
    );
    await mount('slack');
    await openAdd();
    await type(field<HTMLInputElement>('Channel ID'), 'C0DEPLOY');
    await choose(field<HTMLSelectElement>('Mode'), 'all');
    await waitMs(PREVIEW_DEBOUNCE_MS + 100);

    const pre = drawer()?.querySelector('pre');
    expect(pre?.textContent).toBe('<img src=x onerror=alert(1)><script>alert(2)</script>');
    expect(pre?.querySelector('img, script')).toBeNull();
    const text = drawer()?.textContent ?? '';
    expect(text).toContain('3f9a1c2e');
    expect(text).toContain('C0DEPLOY → * → personality');
    expect(text).toContain('Identity line omitted');
    expect(previewFn).toHaveBeenCalled();
    expect(previewFn.mock.calls.at(-1)?.[0]).toMatchObject({
      platform: 'slack',
      chatId: 'C0DEPLOY',
      isDm: false,
      draft: { selector: 'C0DEPLOY', entry: { prompt: '', mode: 'all' } },
    });
  });

  it('debounces: one preview call for a burst of typing', async () => {
    await mount('slack');
    await openAdd();
    const id = field<HTMLInputElement>('Channel ID');
    for (const v of ['C', 'C0', 'C0D', 'C0DE']) await type(id, v);
    await waitMs(PREVIEW_DEBOUNCE_MS + 100);
    expect(previewFn).toHaveBeenCalledTimes(1);
  });
});

describe('Deep link', () => {
  it('scrolls the section into view when the URL hash is #rooms', async () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    window.location.hash = '#rooms';
    await mount('slack');
    expect(document.getElementById('rooms-slack')).not.toBeNull();
    expect(document.getElementById('rooms-heading-slack')).not.toBeNull();
    expect(document.getElementById('rooms')).toBeNull();
    expect(scroll).toHaveBeenCalledTimes(1);
  });

  it('does not scroll without the hash', async () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    await mount('slack');
    expect(scroll).not.toHaveBeenCalled();
  });
});
