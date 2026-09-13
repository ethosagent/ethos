// @vitest-environment jsdom
//
// The list half of paged history: a top sentinel asks for the next-older page,
// a prepend keeps the reader's place (scrollTop grows by exactly the height
// that was added above), the bottom pin follows APPENDS only, and the top of
// the list carries one feedback row while a page loads or after one failed.
//
// jsdom does no layout, so `scrollHeight`/`clientHeight` are stubbed on the
// list element and `scrollTop` is given a real backing value.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../../../lib/chat-reducer';
import { MessageList, type MessageListProps } from '../MessageList';

// The save modal routes (useNavigate); it is closed and not under test here.
vi.mock('../../dashboard/SaveToDashboardModal', () => ({
  SaveToDashboardModal: () => null,
}));

vi.mock('../../../features/renderers/resolver', () => ({
  useFenceResolver: () => () => null,
}));

class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];
  readonly observed: Element[] = [];
  disconnected = false;
  constructor(
    readonly callback: IntersectionObserverCallback,
    readonly options: IntersectionObserverInit = {},
  ) {
    FakeIntersectionObserver.instances.push(this);
  }
  observe(el: Element) {
    this.observed.push(el);
  }
  disconnect() {
    this.disconnected = true;
  }
  unobserve() {}
  takeRecords() {
    return [];
  }
}

/** Report the sentinel as visible to every live observer. */
function intersect() {
  for (const io of FakeIntersectionObserver.instances.filter((i) => !i.disconnected)) {
    io.callback(
      io.observed.map((target) => ({ target, isIntersecting: true }) as IntersectionObserverEntry),
      io as unknown as IntersectionObserver,
    );
  }
}

function user(id: string): ChatMessage {
  return { id, role: 'user', content: `message ${id}`, timestamp: 0 };
}

let container: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;
let scrollHeight = 1000;
const CLIENT_HEIGHT = 500;

async function render(props: Partial<MessageListProps> & { messages: ChatMessage[] }) {
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(MessageList, { currentTurn: null, ...props }),
      ),
    );
  });
}

function list(): HTMLDivElement {
  const el = container.querySelector<HTMLDivElement>('.message-list');
  if (!el) throw new Error('list not rendered');
  return el;
}

/** Give the list a real scrollTop and put the reader at `top`, firing scroll. */
function scrollListTo(top: number) {
  const el = list();
  let value = top;
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => value,
    set: (v: number) => {
      value = v;
    },
  });
  el.dispatchEvent(new Event('scroll'));
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0);
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
  FakeIntersectionObserver.instances = [];
  scrollHeight = 1000;
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    get() {
      return (this as HTMLElement).classList.contains('message-list') ? scrollHeight : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get() {
      return (this as HTMLElement).classList.contains('message-list') ? CLIENT_HEIGHT : 0;
    },
  });
  queryClient = new QueryClient();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  // Back to jsdom's own (layout-free) accessors.
  delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight;
  delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight;
});

describe('MessageList — top sentinel', () => {
  it('asks for the older page when the sentinel scrolls into the list', async () => {
    const onLoadOlder = vi.fn();
    await render({
      messages: [user('u3'), user('u4')],
      hasOlder: true,
      olderStatus: 'idle',
      onLoadOlder,
    });

    const io = FakeIntersectionObserver.instances.at(-1);
    expect(io?.options.root).toBe(list());
    expect(io?.observed).toHaveLength(1);

    intersect();
    expect(onLoadOlder).toHaveBeenCalledTimes(1);
  });

  it('does not ask again while a page is loading, nor when nothing is older', async () => {
    const onLoadOlder = vi.fn();
    await render({ messages: [user('u3')], hasOlder: true, olderStatus: 'loading', onLoadOlder });
    intersect();
    expect(onLoadOlder).not.toHaveBeenCalled();

    await render({ messages: [user('u3')], hasOlder: false, olderStatus: 'idle', onLoadOlder });
    intersect();
    expect(onLoadOlder).not.toHaveBeenCalled();
  });
});

describe('MessageList — scroll position across a prepend', () => {
  it('grows scrollTop by the added height and does not jump to the bottom, even when pinned', async () => {
    await render({ messages: [user('u3'), user('u4')], hasOlder: true, olderStatus: 'idle' });
    // Pinned: scrollHeight 1000 - scrollTop 500 - clientHeight 500 = 0 from the bottom.
    scrollListTo(500);

    scrollHeight = 1600;
    await render({
      messages: [user('u1'), user('u2'), user('u3'), user('u4')],
      hasOlder: false,
      olderStatus: 'idle',
    });

    expect(list().scrollTop).toBe(500 + 600);
  });

  it('keeps following an append while pinned to the bottom', async () => {
    await render({ messages: [user('u3'), user('u4')] });
    scrollListTo(500);

    scrollHeight = 1300;
    await render({ messages: [user('u3'), user('u4'), user('u5')] });

    expect(list().scrollTop).toBe(1300);
  });

  it('leaves an unpinned reader alone on append', async () => {
    await render({ messages: [user('u3'), user('u4')] });
    scrollListTo(100);

    scrollHeight = 1300;
    await render({ messages: [user('u3'), user('u4'), user('u5')] });

    expect(list().scrollTop).toBe(100);
  });
});

describe('MessageList — earlier-messages status row', () => {
  it('renders a running row while a page loads', async () => {
    await render({ messages: [user('u3')], hasOlder: true, olderStatus: 'loading' });

    const status = container.querySelector('.message-list-older [role="status"]');
    expect(status?.textContent).toContain('running');
    expect(status?.textContent).toContain('Loading earlier messages…');
    expect(status?.querySelector('.activity-row-running')).not.toBeNull();
    expect(status?.querySelector('button')).toBeNull();
  });

  it('renders a failed row with Retry after a page fails', async () => {
    const onLoadOlder = vi.fn();
    await render({ messages: [user('u3')], hasOlder: true, olderStatus: 'error', onLoadOlder });

    const status = container.querySelector('.message-list-older [role="status"]');
    expect(status?.textContent).toContain('✗');
    expect(status?.textContent).toContain('failed');
    expect(status?.textContent).toContain('Earlier messages did not load');
    const retry = status?.querySelector('button');
    expect(retry?.textContent).toBe('Retry');

    await act(async () => {
      retry?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onLoadOlder).toHaveBeenCalledTimes(1);
  });

  it('renders nothing at the top when there is nothing older', async () => {
    await render({ messages: [user('u3')], hasOlder: false, olderStatus: 'idle' });
    expect(container.querySelector('.message-list-older')).toBeNull();
    expect(container.textContent).not.toContain('earlier messages');
  });
});
