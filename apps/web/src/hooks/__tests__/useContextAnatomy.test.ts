// @vitest-environment jsdom
//
// useContextAnatomy: the ring numerator is the anatomy's measured total; a
// post-compact estimate overrides it only for the same session and the same
// llm_call count; usage events and turn end refetch; compacting is single-flight.

import type { ContextAnatomyWire } from '@ethosagent/web-contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import type { CompactResult } from '../../lib/notify-compact-result';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

const contextAnatomy = vi.fn();
vi.mock('../../rpc', () => ({ rpc: { sessions: { contextAnatomy } } }));

const { useContextAnatomy } = await import('../useContextAnatomy');
type Hook = ReturnType<typeof useContextAnatomy>;

function anatomy(over: Partial<ContextAnatomyWire> = {}): ContextAnatomyWire {
  return {
    system: 1000,
    tools: 400,
    messages: 5000,
    total: 6400,
    inputTokens: 6400,
    cacheReadTokens: 0,
    cacheHitRate: 0,
    llmCallCount: 1,
    memory: 0,
    skills: 0,
    contextWindow: 200_000,
    compactAtTokens: 100_000,
    ...over,
  };
}

const ok: CompactResult = {
  ok: true,
  engineName: 'e',
  droppedCount: 2,
  preTotalTokens: 9000,
  postTotalTokens: 3000,
  summariesEnabled: true,
};

interface Props {
  sessionId: string | null;
  turnBusy: boolean;
  liveTokens: number | null;
}

let container: HTMLDivElement;
let root: Root;
let current: Hook;
let compact: Mock<(focus?: string) => Promise<CompactResult>>;
const notification = { info: vi.fn(), success: vi.fn() };

// One QueryClient across rerenders so the cache survives them.
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
// A stable component type: a fresh one per render would remount and reset the hook.
let props: Props = { sessionId: 's1', turnBusy: false, liveTokens: null };
function Harness() {
  current = useContextAnatomy(props.sessionId, { ...props, compact, notification });
  return null;
}

async function rerender(p: Props): Promise<void> {
  props = p;
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client }, createElement(Harness)));
  });
  await settle();
}

/** Let the query resolve and React commit its result. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  client.clear();
  contextAnatomy.mockReset();
  contextAnatomy.mockResolvedValue({ anatomy: anatomy() });
  compact = vi.fn<(focus?: string) => Promise<CompactResult>>().mockResolvedValue(ok);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const DEBOUNCE_WAIT = 400;
async function sleep(ms: number): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

const base: Props = { sessionId: 's1', turnBusy: false, liveTokens: null };

describe('useContextAnatomy', () => {
  it('uses the anatomy total, not live tokens, as the numerator', async () => {
    await rerender({ ...base, liveTokens: 99_999 });
    expect(current.usedTokens).toBe(6400);
  });

  it('falls back to live tokens when there is no anatomy', async () => {
    contextAnatomy.mockResolvedValue({ anatomy: null });
    await rerender({ ...base, liveTokens: 1234 });
    expect(current.usedTokens).toBe(1234);
  });

  it('refetches (debounced) when a turn goes busy to idle', async () => {
    await rerender({ ...base, turnBusy: true });
    const before = contextAnatomy.mock.calls.length;
    await rerender({ ...base, turnBusy: false });
    await sleep(DEBOUNCE_WAIT);
    expect(contextAnatomy.mock.calls.length).toBe(before + 1);
  });

  it('refetches when a usage event changes live tokens', async () => {
    await rerender(base);
    const before = contextAnatomy.mock.calls.length;
    await rerender({ ...base, liveTokens: 5000 });
    await sleep(DEBOUNCE_WAIT);
    expect(contextAnatomy.mock.calls.length).toBe(before + 1);
  });

  it('shows the post-compact estimate after runCompact, calling compact with no argument', async () => {
    await rerender(base);
    await act(async () => current.runCompact());
    await settle();
    expect(compact).toHaveBeenCalledWith(undefined);
    expect(notification.success).toHaveBeenCalled();
    expect(current.usedTokens).toBe(3000);
  });

  it('passes the focus through runCompact', async () => {
    await rerender(base);
    await act(async () => current.runCompact('the API'));
    expect(compact).toHaveBeenCalledWith('the API');
    expect(current.usedTokens).toBe(3000);
  });

  it('ignores the override after a session switch', async () => {
    await rerender(base);
    await act(async () => current.runCompact());
    contextAnatomy.mockResolvedValue({ anatomy: anatomy({ total: 7777 }) });
    await rerender({ ...base, sessionId: 's2' });
    expect(current.usedTokens).toBe(7777);
  });

  it('clears the override when a new llm_call lands', async () => {
    await rerender(base);
    await act(async () => current.runCompact());
    expect(current.usedTokens).toBe(3000);
    contextAnatomy.mockResolvedValue({ anatomy: anatomy({ total: 4100, llmCallCount: 2 }) });
    await rerender({ ...base, liveTokens: 4100 });
    await sleep(DEBOUNCE_WAIT);
    expect(current.usedTokens).toBe(4100);
  });

  it('is single-flight and reports compacting while in flight', async () => {
    await rerender(base);
    let release: (r: CompactResult) => void = () => {};
    compact.mockReturnValue(new Promise<CompactResult>((r) => (release = r)));
    let first: Promise<void> = Promise.resolve();
    await act(async () => {
      first = current.runCompact();
      void current.runCompact();
    });
    expect(compact).toHaveBeenCalledTimes(1);
    expect(current.compacting).toBe(true);
    await act(async () => {
      release(ok);
      await first;
    });
    expect(current.compacting).toBe(false);
  });

  it('does not refetch after compaction (it writes no llm_call span)', async () => {
    await rerender(base);
    const before = contextAnatomy.mock.calls.length;
    await act(async () => current.runCompact());
    await sleep(DEBOUNCE_WAIT);
    expect(contextAnatomy.mock.calls.length).toBe(before);
  });

  it('ignores a non-finite postTotalTokens', async () => {
    compact.mockResolvedValue({ ...ok, postTotalTokens: Number.NaN });
    await rerender(base);
    await act(async () => current.runCompact());
    expect(current.usedTokens).toBe(6400);
  });

  it('a usage event then busy to idle costs exactly one RPC', async () => {
    await rerender({ ...base, turnBusy: true });
    vi.useFakeTimers();
    try {
      const before = contextAnatomy.mock.calls.length;
      await act(async () => {
        props = { ...base, turnBusy: true, liveTokens: 5000 };
        root.render(createElement(QueryClientProvider, { client }, createElement(Harness)));
      });
      await act(async () => {
        props = { ...base, turnBusy: false, liveTokens: 5000 };
        root.render(createElement(QueryClientProvider, { client }, createElement(Harness)));
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(DEBOUNCE_WAIT);
      });
      expect(contextAnatomy.mock.calls.length).toBe(before + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a null liveTokens reset causes no RPC', async () => {
    await rerender({ ...base, liveTokens: 5000 });
    await sleep(DEBOUNCE_WAIT);
    const before = contextAnatomy.mock.calls.length;
    await rerender({ ...base, liveTokens: null });
    await sleep(DEBOUNCE_WAIT);
    expect(contextAnatomy.mock.calls.length).toBe(before);
  });
});
