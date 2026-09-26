import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { StatusLine } from '../chat/StatusLine';
import { backendStatusView } from '../StatusBar';

// W2 follow-up — `sse.ts` reports three states, but `closed` (readyState 2:
// the browser gave up, only a fresh subscribe reopens the stream) used to
// render NOWHERE: StatusLine knew only `reconnecting` and StatusBar mapped
// only `reconnecting`. Per DESIGN.md "Connection status indicator" the dot is
// three-state and `closed` is the offline (red, solid) one; the status line
// says `connection lost` while a turn is live.

describe('backendStatusView — the closed SSE state renders as offline', () => {
  it('maps closed to the offline dot with a concrete label', () => {
    expect(backendStatusView({ isLoading: false, hasError: false, sse: 'closed' })).toEqual({
      state: 'offline',
      label: 'disconnected — reload',
    });
  });

  it('keeps the existing states unchanged', () => {
    expect(backendStatusView({ isLoading: true, hasError: false, sse: null }).state).toBe(
      'connecting',
    );
    expect(backendStatusView({ isLoading: false, hasError: true, sse: 'open' }).state).toBe(
      'offline',
    );
    expect(backendStatusView({ isLoading: false, hasError: false, sse: 'reconnecting' })).toEqual({
      state: 'connecting',
      label: 'reconnecting…',
    });
    expect(backendStatusView({ isLoading: false, hasError: false, sse: 'open' })).toEqual({
      state: 'connected',
      label: 'Backend connected',
    });
    expect(backendStatusView({ isLoading: false, hasError: false, sse: null }).state).toBe(
      'connected',
    );
  });

  it('a tolerated unknown/absent SSE state never reads as offline', () => {
    // Belt and braces for version skew: only the two degraded states change
    // the dot; anything else is the connected default.
    expect(backendStatusView({ isLoading: false, hasError: false, sse: null }).state).toBe(
      'connected',
    );
  });
});

describe('StatusLine — connection lost while a turn is live', () => {
  it('says `connection lost` when the stream is closed', () => {
    const html = renderToStaticMarkup(
      createElement(StatusLine, {
        phase: 'writing',
        label: null,
        elapsedMs: 1_000,
        stalled: false,
        connectionLost: true,
      }),
    );
    expect(html).toContain('connection lost');
    expect(html).not.toContain('reconnecting…');
  });

  it('closed outranks reconnecting when both are somehow set', () => {
    const html = renderToStaticMarkup(
      createElement(StatusLine, {
        phase: 'writing',
        label: null,
        elapsedMs: 1_000,
        stalled: false,
        reconnecting: true,
        connectionLost: true,
      }),
    );
    expect(html).toContain('connection lost');
    expect(html).not.toContain('reconnecting…');
  });

  it('still renders the reconnecting note alone', () => {
    const html = renderToStaticMarkup(
      createElement(StatusLine, {
        phase: 'writing',
        label: null,
        elapsedMs: 1_000,
        stalled: false,
        reconnecting: true,
      }),
    );
    expect(html).toContain('reconnecting…');
    expect(html).not.toContain('connection lost');
  });
});
