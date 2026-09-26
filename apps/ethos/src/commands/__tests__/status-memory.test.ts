// U9 (plan/phases/openclaw-2026.9.6-gaps.md) — the ~150 MB idle footprint was
// documented and never measured. The gateway heartbeat now carries the running
// process's resident set size (`buildGatewayHeartbeat`), and `ethos status`
// reports it from the heartbeat file: the status command's OWN
// `process.memoryUsage()` would describe a short-lived CLI, not the daemon.

import type { PlatformAdapter } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { buildGatewayHeartbeat } from '../gateway';
import { gatewayMemoryFacet } from '../status';

const NOW = Date.parse('2026-09-25T12:00:00Z');

describe('buildGatewayHeartbeat memory', () => {
  it('records this process rss in the heartbeat', async () => {
    const hb = await buildGatewayHeartbeat([] as PlatformAdapter[], '2026-09-25T00:00:00Z');
    expect(hb.rssBytes).toBeGreaterThan(0);
  });
});

describe('gatewayMemoryFacet', () => {
  it('reports the gateway rss from a fresh heartbeat', () => {
    const raw = JSON.stringify({
      updatedAt: new Date(NOW - 4_000).toISOString(),
      rssBytes: 150 * 1024 * 1024,
    });
    expect(gatewayMemoryFacet(raw, NOW)).toEqual({
      gatewayRssBytes: 157286400,
      heartbeatAgeSec: 4,
    });
  });

  it('reports nothing when the heartbeat is stale, absent or predates the field', () => {
    const stale = JSON.stringify({
      updatedAt: new Date(NOW - 120_000).toISOString(),
      rssBytes: 1,
    });
    const old = JSON.stringify({ updatedAt: new Date(NOW - 1_000).toISOString() });
    const none = { gatewayRssBytes: null, heartbeatAgeSec: null };
    expect(gatewayMemoryFacet(stale, NOW)).toEqual(none);
    expect(gatewayMemoryFacet(null, NOW)).toEqual(none);
    expect(gatewayMemoryFacet('not json', NOW)).toEqual(none);
    expect(gatewayMemoryFacet(old, NOW)).toEqual(none);
  });
});
