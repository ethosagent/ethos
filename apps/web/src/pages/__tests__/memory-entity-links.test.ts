// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

const mountsFn = vi.fn();
const linkifyFn = vi.fn();
vi.mock('../../rpc', () => ({ rpc: { worlds: { mounts: mountsFn, linkify: linkifyFn } } }));

const { LinkedNote } = await import('../../components/world/LinkedNote');

const NOTE = 'Ravi owns billing. Ada reviews.';
let root: Root;
let host: HTMLElement;

async function render() {
  const client = new QueryClient();
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(
          MemoryRouter,
          null,
          createElement(LinkedNote, { personalityId: 'engineer', text: NOTE }),
        ),
      ),
    );
  });
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  // The server answers per world; only acme knows Ravi, only ops knows Ada.
  linkifyFn.mockImplementation(async ({ world }: { world: string; text: string }) => {
    if (world === 'world:acme') {
      return {
        spans: [
          { text: 'Ravi', entity: { id: 'e-ravi', type: 'Person' } },
          { text: ' owns billing. Ada reviews.' },
        ],
      };
    }
    if (world === 'world:ops') {
      return {
        spans: [
          { text: 'Ravi owns billing. ' },
          { text: 'Ada', entity: { id: 'e-ada', type: 'Person' } },
          { text: ' reviews.' },
        ],
      };
    }
    return { spans: [{ text: NOTE }] };
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.clearAllMocks();
});

describe('memory entity links', () => {
  it('a name in a note links to its entity', async () => {
    mountsFn.mockResolvedValue({
      mounts: [{ world: 'acme', mode: 'read' }],
      effective: [{ world: 'acme', effective: 'read' }],
    });
    await render();
    const a = host.querySelector('a[data-entity="e-ravi"]');
    expect(a?.textContent).toBe('Ravi');
    expect(a?.getAttribute('href')).toBe('/world?world=world%3Aacme&entity=e-ravi');
    expect(host.querySelector('pre')?.textContent).toBe(NOTE);
  });

  it('a name from an unmounted world does not link', async () => {
    mountsFn.mockResolvedValue({
      mounts: [
        { world: 'acme', mode: 'read' },
        { world: 'legal', mode: 'read' },
      ],
      effective: [
        { world: 'acme', effective: 'read' },
        { world: 'legal', effective: 'read', note: 'inert: not in readers or proposers' },
      ],
    });
    await render();
    // ops is not mounted and legal is inert: neither is asked, so Ada stays plain text.
    const asked = linkifyFn.mock.calls.map((c) => c[0].world);
    expect(asked).toEqual(['personality:engineer', 'world:acme']);
    expect(host.querySelector('a[data-entity="e-ada"]')).toBeNull();
    expect(host.textContent).toContain('Ada');
  });
});
