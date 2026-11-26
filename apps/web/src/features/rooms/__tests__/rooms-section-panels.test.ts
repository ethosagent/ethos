// @vitest-environment jsdom

// Communications > Rooms (plan/phases/channel-prompts-ui.md L5); shared mocks and helpers in rooms-section.fixtures.ts.

import type { RoomPlatform } from '@ethosagent/web-contracts';
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  button,
  byText,
  choose,
  click,
  deleteFn,
  drawer,
  entry,
  field,
  installRoomsHarness,
  listFn,
  listResponse,
  mount,
  openAdd,
  PREVIEW_DEBOUNCE_MS,
  platformSetFn,
  previewFn,
  previewResponse,
  recentFn,
  resetRoot,
  root,
  row,
  setFn,
  type,
  waitMs,
} from './rooms-section.fixtures';

installRoomsHarness();

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
      resetRoot();
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
      resetRoot();
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
    resetRoot();
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
    resetRoot();
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
