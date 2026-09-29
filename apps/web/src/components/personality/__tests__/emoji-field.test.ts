import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { EmojiField, emojiDraftStatus } from '../EmojiField';

// plan personality-presence-and-initiative §2 — the Identity tab's emoji field,
// beside the AvatarPicker. The same `isSingleEmojiGrapheme` the server enforces
// (web-contracts `personalities.update`, `FilePersonalityRegistry.update`)
// gates the Set button, so an invalid value never leaves the page.

describe('emojiDraftStatus', () => {
  it('accepts one emoji and flags a change from the saved value', () => {
    expect(emojiDraftStatus('🦉', undefined)).toEqual({ value: '🦉', valid: true, changed: true });
  });

  it('treats surrounding whitespace as noise', () => {
    expect(emojiDraftStatus(' 🦉 ', '🦉')).toEqual({ value: '🦉', valid: true, changed: false });
  });

  it('an empty draft is valid — it clears a saved emoji', () => {
    expect(emojiDraftStatus('', '🦉')).toEqual({ value: '', valid: true, changed: true });
    expect(emojiDraftStatus('', undefined).changed).toBe(false);
  });

  it.each(['🦉🦉', 'ab', 'x'.repeat(200)])('refuses %s', (draft) => {
    expect(emojiDraftStatus(draft, undefined).valid).toBe(false);
  });
});

describe('EmojiField', () => {
  it('shows the saved emoji with Set disabled until the draft changes', () => {
    const html = renderToStaticMarkup(createElement(EmojiField, { value: '🦉', onSave: () => {} }));
    expect(html).toContain('value="🦉"');
    expect(html).toContain('aria-label="Emoji"');
    expect(html).toMatch(/<button[^>]*disabled[^>]*>.*Set/);
    expect(html).not.toContain('One emoji');
  });
});
