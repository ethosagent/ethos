// @vitest-environment jsdom

// ShareDialog edge behaviour from the Opus review of Lane F: too_large with
// tools on, the double-click guard, focus and switch semantics, wording, and
// the error and close-mid-create paths.

import { act } from 'react';
import { describe, expect, it } from 'vitest';
import {
  button,
  choose,
  click,
  created,
  createFn,
  FAKE_TOKEN,
  input,
  installShareHarness,
  mountDialog,
  PREVIEW_DEBOUNCE_MS,
  previewFn,
  SESSION,
  snapshot,
  text,
  waitMs,
} from './share.fixtures';

installShareHarness();

const TOO_LARGE = { ok: false, reason: 'too_large', limitBytes: 2_097_152 } as const;
const TOO_LARGE_NOTE =
  'This conversation is too large to share. Turn off Include tool names and try again.';

describe('too_large while Include tool names is on (F6)', () => {
  it('keeps the form and toggles usable, shows the note, disables Create, and recovers', async () => {
    previewFn.mockImplementation(async (i: { includeToolNames: boolean }) =>
      i.includeToolNames ? TOO_LARGE : snapshot(),
    );
    await mountDialog();
    await click(input('share-tools'));
    await waitMs(PREVIEW_DEBOUNCE_MS + 60);

    expect(text()).toContain(TOO_LARGE_NOTE);
    expect(input('share-tools').checked).toBe(true);
    expect(document.getElementById('share-expiry')).not.toBeNull();
    expect(button('Create link').disabled).toBe(true);
    expect(createFn).not.toHaveBeenCalled();

    await click(input('share-tools'));
    await waitMs(PREVIEW_DEBOUNCE_MS + 60);
    expect(text()).not.toContain('too large');
    expect(button('Create link').disabled).toBe(false);
  });

  it('with tools off keeps the refusal frame (no form)', async () => {
    previewFn.mockResolvedValue(TOO_LARGE);
    await mountDialog();
    expect(text()).toContain('This conversation is too large to share.');
    expect(text()).not.toContain('Turn off Include tool names');
    expect(document.getElementById('share-tools')).toBeNull();
    expect(button('Create link').disabled).toBe(true);
  });
});

describe('in-flight guard (F8)', () => {
  it('two synchronous clicks on Create link call create once', async () => {
    createFn.mockImplementation(() => new Promise(() => {}));
    await mountDialog();
    const create = button('Create link');
    await act(async () => {
      create.click();
      create.click();
    });
    expect(createFn).toHaveBeenCalledTimes(1);
  });

  it('allows a retry after the create failed', async () => {
    createFn.mockRejectedValueOnce(new Error('net'));
    await mountDialog();
    await click(button('Create link'));
    expect(text()).toContain('Could not create the link. Try again.');
    await click(button('Create link'));
    expect(createFn).toHaveBeenCalledTimes(2);
    expect(text()).toContain('Link created');
  });
});

describe('focus and semantics (F9)', () => {
  it('moves focus to Copy once the link is created', async () => {
    await mountDialog();
    await click(button('Create link'));
    expect(document.activeElement).toBe(button('Copy'));
  });

  it('exposes the two toggles as switches that track their state', async () => {
    await mountDialog();
    for (const id of ['share-tools', 'share-pii']) {
      expect(input(id).getAttribute('role')).toBe('switch');
    }
    expect(input('share-tools').getAttribute('aria-checked')).toBe('false');
    expect(input('share-pii').getAttribute('aria-checked')).toBe('true');
    await click(input('share-tools'));
    expect(input('share-tools').getAttribute('aria-checked')).toBe('true');
  });

  it('keeps the URL box out of spellcheck and autofill', async () => {
    await mountDialog();
    await click(button('Create link'));
    const box = document.querySelector('[aria-label="Share URL"]');
    expect(box?.getAttribute('spellcheck')).toBe('false');
    expect(box?.getAttribute('autocomplete')).toBe('off');
  });
});

describe('wording (F11, F12)', () => {
  it('pluralises turns', async () => {
    const one = snapshot();
    one.snapshot.turns = one.snapshot.turns.slice(0, 1);
    previewFn.mockResolvedValue(one);
    await mountDialog();
    expect(text()).toContain('1 turn');
    expect(text()).not.toContain('1 turns');
  });

  it('names the place Security & access after create', async () => {
    await mountDialog();
    await click(button('Create link'));
    expect(text()).toContain('revoke it in Settings → Security & access');
  });

  it('labels a shared-session refusal with shared room', async () => {
    previewFn.mockResolvedValue({ ok: false, reason: 'shared_session' });
    await mountDialog();
    expect(document.querySelector('.share-ctx')?.textContent).toBe(
      'Fix flaky retry test · engineer · shared room',
    );
  });

  it('labels it incognito when the session says so', async () => {
    previewFn.mockResolvedValue({ ok: false, reason: 'shared_session' });
    await mountDialog(() => {}, { ...SESSION, incognito: true });
    expect(document.querySelector('.share-ctx')?.textContent).toBe(
      'Fix flaky retry test · engineer · incognito',
    );
  });
});

describe('error and close paths', () => {
  it('shows a retryable error when create fails on the network', async () => {
    createFn.mockRejectedValue(new Error('network down'));
    await mountDialog();
    await click(button('Create link'));
    expect(text()).toContain('Could not create the link. Try again.');
    expect(button('Create link').disabled).toBe(false);
  });

  it('renders no URL when the dialog is closed while create is in flight', async () => {
    let resolve: (v: ReturnType<typeof created>) => void = () => {};
    createFn.mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    await mountDialog();
    await click(button('Create link'));
    await click(button('Cancel'));
    await act(async () => resolve(created()));
    expect(document.querySelector('.share-dialog')).toBeNull();
    expect(document.body.textContent).not.toContain(FAKE_TOKEN);
  });

  it('replaces the earlier preview with the error when a later preview fails', async () => {
    previewFn.mockResolvedValueOnce(snapshot());
    previewFn.mockRejectedValue(new Error('boom'));
    await mountDialog();
    expect(text()).toContain('Switched to jittered backoff.');
    await click(input('share-pii'));
    await waitMs(PREVIEW_DEBOUNCE_MS + 60);
    expect(text()).toContain('Could not build the preview.');
    expect(text()).not.toContain('Switched to jittered backoff.');
    expect(button('Create link').disabled).toBe(true);
  });
});

describe('expiry select still works with the guard', () => {
  it('sends the chosen expiry', async () => {
    await mountDialog();
    await choose(document.getElementById('share-expiry') as HTMLSelectElement, '30d');
    await click(button('Create link'));
    expect(createFn).toHaveBeenCalledWith(expect.objectContaining({ expiresIn: '30d' }));
  });
});
