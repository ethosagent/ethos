import { afterEach, describe, expect, it } from 'vitest';
import { CallMetrics } from '../call-metrics';
import type { HostSpanEnd, HostSpanStart } from '../events';
import {
  callTool,
  eventsOf,
  fixtureDir,
  type Harness,
  makeHarness,
  waitFor,
} from './helpers/harness';

let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

const SLOW = 30_000;

function spanRecorder() {
  const spans: Array<{ start: HostSpanStart; end: HostSpanEnd }> = [];
  return {
    spans,
    onSpan: (start: HostSpanStart) => (end: HostSpanEnd) => void spans.push({ start, end }),
  };
}

describe('plugin_call spans', () => {
  it(
    'records one span per tool call with ids, sizes and both timings, and tags failures',
    async () => {
      const rec = spanRecorder();
      h = await makeHarness({ now: Date.now, onSpan: rec.onSpan, statsIntervalMs: 0 });
      const lease = await h.pool.acquire({ id: 'echo', dir: fixtureDir('echo') });
      await callTool(lease, 'echo', { text: 'hello' });
      await callTool(lease, 'echo_throw');

      const ok = rec.spans.find((s) => s.start.name === 'tool.execute:echo');
      expect(ok?.start).toMatchObject({
        pluginId: 'echo',
        toolCallId: 'call-echo',
        sessionId: 's1',
      });
      expect(ok?.end.outcome).toBe('ok');
      expect(ok?.end.reqBytes).toBeGreaterThan(0);
      expect(ok?.end.resBytes).toBeGreaterThan(0);
      expect(ok?.end.hostMs).toBeGreaterThanOrEqual(0);
      expect(ok?.end.ipcMs).toBeGreaterThanOrEqual(ok?.end.hostMs ?? 0);

      const bad = rec.spans.find((s) => s.start.name === 'tool.execute:echo_throw');
      expect(bad?.end.outcome).toBe('error');
    },
    SLOW,
  );

  it(
    'a throwing span sink never breaks the call',
    async () => {
      h = await makeHarness({
        now: Date.now,
        statsIntervalMs: 0,
        onSpan: () => {
          throw new Error('sink down');
        },
      });
      const lease = await h.pool.acquire({ id: 'echo', dir: fixtureDir('echo') });
      expect(await callTool(lease, 'echo', { text: 'x' })).toEqual({ ok: true, value: 'x' });
    },
    SLOW,
  );
});

describe('plugin_host.stats', () => {
  it(
    'emits per-window counters with the child rss, stops with the host, and spawned carries rss',
    async () => {
      h = await makeHarness({ now: Date.now, statsIntervalMs: 150 });
      const lease = await h.pool.acquire({ id: 'echo', dir: fixtureDir('echo') });
      expect(eventsOf(h, 'plugin_host.spawned')[0]?.payload.rss_mb).toEqual(expect.any(Number));
      await callTool(lease, 'echo', { text: 'a' });
      await waitFor(() => eventsOf(h as Harness, 'plugin_host.stats').length > 0);
      const first = eventsOf(h, 'plugin_host.stats')[0]?.payload;
      expect(first).toMatchObject({
        plugin_id: 'echo',
        calls: expect.any(Number),
        p50_ms: expect.any(Number),
        p95_ms: expect.any(Number),
        bytes_in: expect.any(Number),
        bytes_out: expect.any(Number),
        timeouts: 0,
        dropped_void: 0,
        rss_mb: expect.any(Number),
      });
      expect(Number(first?.calls)).toBeGreaterThanOrEqual(1);

      await h.pool.dispose();
      const after = eventsOf(h, 'plugin_host.stats').length;
      await new Promise((r) => setTimeout(r, 400));
      expect(eventsOf(h, 'plugin_host.stats').length).toBe(after);
    },
    SLOW,
  );
});

describe('CallMetrics', () => {
  it('reports p50/p95 and bytes for a window, then starts a new one', () => {
    const m = new CallMetrics();
    for (let i = 1; i <= 100; i++) m.record(i, 10, 20);
    expect(m.drain()).toEqual({
      calls: 100,
      p50_ms: 50,
      p95_ms: 95,
      bytes_in: 2000,
      bytes_out: 1000,
    });
    expect(m.drain().calls).toBe(0);
  });
});
