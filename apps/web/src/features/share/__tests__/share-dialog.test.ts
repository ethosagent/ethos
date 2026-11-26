// @vitest-environment jsdom

// ShareDialog flow (plan share-links.md Lane F1, mockup screens 1a-1c).

import { describe, expect, it, vi } from 'vitest';
import {
  button,
  choose,
  click,
  client,
  created,
  createFn,
  FAKE_TOKEN,
  input,
  installShareHarness,
  mountDialog,
  PREVIEW_DEBOUNCE_MS,
  previewFn,
  text,
  waitMs,
  writeText,
} from './share.fixtures';

installShareHarness();

describe('ShareDialog form and preview', () => {
  it('opens with 7 days, tools off, PII on, and shows the redacted preview', async () => {
    await mountDialog();
    const select = document.getElementById('share-expiry');
    expect(select).toBeInstanceOf(HTMLSelectElement);
    expect((select as HTMLSelectElement).value).toBe('7d');
    expect([...(select as HTMLSelectElement).options].map((o) => o.textContent)).toEqual([
      '1 hour',
      '1 day',
      '7 days',
      '30 days',
    ]);
    expect(input('share-tools').checked).toBe(false);
    expect(input('share-pii').checked).toBe(true);
    expect(previewFn).toHaveBeenCalledWith({
      sessionId: 'sess-1',
      includeToolNames: false,
      pii: true,
    });
    expect(text()).toContain('Preview');
    expect(text()).toContain('Switched to jittered backoff.');
    expect(document.body.querySelector('.share-red')?.textContent).toBe('[REDACTED:email]');
    expect(text()).toContain('2 turns');
    expect(button('Create link').disabled).toBe(false);
  });

  it('re-fetches the preview (debounced) when a toggle changes and shows tool chips', async () => {
    await mountDialog();
    expect(previewFn).toHaveBeenCalledTimes(1);
    expect(document.body.querySelector('.share-chip')).toBeNull();

    await click(input('share-tools'));
    await click(input('share-pii'));
    // Debounced: nothing new yet, and Create waits for the matching preview.
    expect(previewFn).toHaveBeenCalledTimes(1);
    expect(button('Create link').disabled).toBe(true);

    await waitMs(PREVIEW_DEBOUNCE_MS + 60);
    expect(previewFn).toHaveBeenCalledTimes(2);
    expect(previewFn).toHaveBeenLastCalledWith({
      sessionId: 'sess-1',
      includeToolNames: true,
      pii: false,
    });
    const chips = [...document.body.querySelectorAll('.share-chip')].map((c) => c.textContent);
    expect(chips).toEqual(['run_tests', '✗ write_file']);
    expect(button('Create link').disabled).toBe(false);
  });

  it('sends the same toggles and the chosen expiry on Create link', async () => {
    await mountDialog();
    await click(input('share-tools'));
    await choose(document.getElementById('share-expiry') as HTMLSelectElement, '1h');
    await waitMs(PREVIEW_DEBOUNCE_MS + 60);
    await click(button('Create link'));
    expect(createFn).toHaveBeenCalledWith({
      sessionId: 'sess-1',
      includeToolNames: true,
      pii: true,
      expiresIn: '1h',
    });
  });
});

describe('ShareDialog after create', () => {
  it('shows the URL once with Copy and the one-time warning', async () => {
    await mountDialog();
    await click(button('Create link'));
    const box = document.querySelector<HTMLTextAreaElement>('[aria-label="Share URL"]');
    expect(box?.value).toBe(`https://ethos.example.com/share/${FAKE_TOKEN}`);
    expect(text()).toContain('Link created');
    expect(text()).toContain("You won't see this link again.");
    expect(text()).not.toContain('Opens only on this machine');
    expect(text()).toContain(FAKE_TOKEN.slice(0, 8));
    expect(text()).toContain('user + assistant text, personal info redacted');

    await click(button('Copy'));
    expect(writeText).toHaveBeenCalledWith(`https://ethos.example.com/share/${FAKE_TOKEN}`);
    expect(button('Copied')).toBeTruthy();
  });

  it('says so when the clipboard refuses', async () => {
    writeText.mockRejectedValue(new Error('denied'));
    await mountDialog();
    await click(button('Create link'));
    await click(button('Copy'));
    expect(text()).toContain('Copy failed. Select the link and copy it by hand.');
  });

  it('warns only when the link is loopback', async () => {
    createFn.mockResolvedValue(created({ loopback: true }));
    await mountDialog();
    await click(button('Create link'));
    expect(text()).toContain(
      'Opens only on this machine. Set webBaseUrl and expose the port to share.',
    );
    expect(text()).toContain("You won't see this link again. Copy it now.");
  });

  it('clears the URL when the dialog closes: not in the DOM, mutation cache or storage', async () => {
    const onClose = vi.fn();
    await mountDialog(onClose);
    await click(button('Create link'));
    await click(button('Done'));
    expect(onClose).toHaveBeenCalledTimes(1);

    expect(document.querySelector('.share-dialog')).toBeNull();
    expect(document.body.textContent).not.toContain(FAKE_TOKEN);
    expect(
      client
        .getMutationCache()
        .getAll()
        .some((m) => JSON.stringify(m.state.data ?? null).includes(FAKE_TOKEN)),
    ).toBe(false);
    expect(JSON.stringify({ ...localStorage, ...sessionStorage })).not.toContain(FAKE_TOKEN);
  });

  it('does not log the URL', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((k) =>
      vi.spyOn(console, k).mockImplementation(() => {}),
    );
    await mountDialog();
    await click(button('Create link'));
    await click(button('Copy'));
    for (const s of spies) {
      expect(JSON.stringify(s.mock.calls)).not.toContain(FAKE_TOKEN);
      s.mockRestore();
    }
  });
});
