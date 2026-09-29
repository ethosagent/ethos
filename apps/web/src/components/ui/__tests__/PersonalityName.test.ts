import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PersonalityName, personalityLabel } from '../PersonalityName';

// plan personality-presence-and-initiative §2 — `display.emoji` beside a
// personality's name. The emoji is identity DATA the operator chose, placed
// as text next to the name: never a nav icon, never in place of the generated
// mark (DESIGN.md "Anti-slop rules" / the nav-icon rule). Unset → the bare name.

describe('PersonalityName', () => {
  it('renders the emoji before the name, hidden from assistive tech', () => {
    const html = renderToStaticMarkup(createElement(PersonalityName, { name: 'Owl', emoji: '🦉' }));
    expect(html).toContain('<span class="personality-emoji" aria-hidden="true">🦉</span>');
    expect(html.indexOf('🦉')).toBeLessThan(html.indexOf('Owl'));
  });

  it('is the bare name when no emoji is set', () => {
    expect(renderToStaticMarkup(createElement(PersonalityName, { name: 'Owl' }))).toBe('Owl');
  });
});

describe('personalityLabel', () => {
  it('prefixes the emoji for plain-text slots (tooltips)', () => {
    expect(personalityLabel('Owl', '🦉')).toBe('🦉 Owl');
    expect(personalityLabel('Owl', undefined)).toBe('Owl');
  });
});
