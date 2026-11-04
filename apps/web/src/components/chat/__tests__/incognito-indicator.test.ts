import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { INCOGNITO_PLACEHOLDER } from '../../../lib/incognito';
import { PersonalityBar, type PersonalityBarProps } from '../PersonalityBar';

// Plan incognito-sessions §8.2 "Web UI": a session-scoped label (Geist Mono,
// eye-off stroke icon, --text-secondary) and an End button, drawn only for an
// incognito session. DESIGN.md: no new colour token, no accent, no coloured
// border — the personality accent is identity and must not signal a mode.
// `renderToStaticMarkup` needs no DOM, so this is a plain `.test.ts`.

function bar(props: Partial<PersonalityBarProps> = {}): string {
  return renderToStaticMarkup(
    createElement(
      MemoryRouter,
      null,
      createElement(PersonalityBar, {
        personalityId: 'engineer',
        name: 'Engineer',
        model: 'claude-sonnet-4',
        onNewSession: () => {},
        sessionTitle: 'Scratch',
        ...props,
      }),
    ),
  );
}

/** The `<span class="personality-bar-incognito"...>` element, or ''. */
function label(html: string): string {
  return /<span class="personality-bar-incognito"[\s\S]*?<\/span>/.exec(html)?.[0] ?? '';
}

describe('PersonalityBar incognito indicator', () => {
  it('renders neither the label nor End for a normal session', () => {
    const html = bar();
    expect(html).not.toContain('personality-bar-incognito');
    expect(html).not.toContain('Incognito');
    expect(html).not.toContain('End incognito');
  });

  it('renders the label with an eye-off stroke icon when incognito', () => {
    const html = bar({ incognito: true });
    const el = label(html);
    expect(el).toContain('Incognito');
    expect(el).toContain('stroke="currentColor"');
    expect(el).toContain('stroke-width="1.5"');
    expect(el).toContain('width="16"');
  });

  it('draws the End button only when an end handler is given', () => {
    expect(bar({ incognito: true })).not.toContain('End incognito');
    const html = bar({ incognito: true, onEndIncognito: () => {} });
    expect(html).toContain('aria-label="End incognito session"');
  });

  it('never uses the accent or a coloured border on the label', () => {
    const html = bar({ incognito: true, onEndIncognito: () => {} });
    const el = label(html);
    expect(el).not.toContain('--accent');
    expect(el).not.toContain('style=');
    expect(el).not.toMatch(/border/);
    const end = /<button[^>]*personality-bar-incognito-end[^>]*>/.exec(html)?.[0] ?? '';
    expect(end).not.toContain('--accent');
    expect(end).not.toContain('style=');
  });

  it('exports the composer placeholder', () => {
    expect(INCOGNITO_PLACEHOLDER).toBe('Incognito — not remembered');
  });
});
