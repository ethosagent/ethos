// @vitest-environment jsdom

// ShareDialog refusals (plan share-links.md D9, D15; mockup screen 1d): each
// reason renders its copy, hides the form and leaves Create link disabled.

import { describe, expect, it } from 'vitest';
import {
  button,
  click,
  createFn,
  installShareHarness,
  mountDialog,
  previewFn,
  text,
} from './share.fixtures';

installShareHarness();

const REFUSALS = [
  {
    refusal: { ok: false, reason: 'shared_session' },
    copy: [
      "This session can't be shared.",
      "It happened in a shared room, so it holds other people's words.",
      'Incognito sessions are refused for the same reason',
    ],
  },
  {
    refusal: { ok: false, reason: 'disabled' },
    copy: ['Share links are off.', 'shareLinks.enabled'],
  },
  { refusal: { ok: false, reason: 'not_found' }, copy: ['This session no longer exists.'] },
  {
    refusal: { ok: false, reason: 'excluded_personality', personalityId: 'finance' },
    copy: ['Sharing is off for finance.', 'shareLinks.excludePersonalities'],
  },
  {
    refusal: { ok: false, reason: 'too_large', limitBytes: 2_097_152 },
    copy: ['This conversation is too large to share.', 'over 2.0 MB'],
  },
  { refusal: { ok: false, reason: 'empty' }, copy: ['Nothing to share.', 'after redaction'] },
] as const;

describe('ShareDialog refusals', () => {
  it.each(REFUSALS)(
    '$refusal.reason renders its copy and disables Create',
    async ({ refusal, copy }) => {
      previewFn.mockResolvedValue(refusal);
      await mountDialog();
      for (const piece of copy) expect(text()).toContain(piece);
      expect(document.getElementById('share-expiry')).toBeNull();
      expect(document.getElementById('share-tools')).toBeNull();
      expect(button('Create link').disabled).toBe(true);
      expect(button('Close')).toBeTruthy();
      expect(createFn).not.toHaveBeenCalled();
    },
  );

  it('shows the shared-session state as an alert in the dialog frame', async () => {
    previewFn.mockResolvedValue({ ok: false, reason: 'shared_session' });
    await mountDialog();
    const alert = document.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("This session can't be shared.");
    expect(text()).toContain('Share session');
    await click(button('Close'));
    expect(document.querySelector('.share-dialog')).toBeNull();
  });

  it('renders a refusal that comes back from create (the setting flipped meanwhile)', async () => {
    createFn.mockResolvedValue({ ok: false, reason: 'disabled' });
    await mountDialog();
    await click(button('Create link'));
    expect(text()).toContain('Share links are off.');
    expect(button('Create link').disabled).toBe(true);
  });

  it('keeps Create disabled and says so when the preview request fails', async () => {
    previewFn.mockRejectedValue(new Error('boom'));
    await mountDialog();
    expect(text()).toContain('Could not build the preview.');
    expect(button('Create link').disabled).toBe(true);
  });
});
