import type { PlatformAdapter } from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import { buildGatewayHeartbeat } from '../gateway';

function stubAdapter(
  id: string,
  healthResult: { ok: boolean; latencyMs?: number },
): PlatformAdapter {
  return {
    id,
    displayName: id,
    canSendTyping: false,
    canEditMessage: false,
    canReact: false,
    canSendFiles: false,
    maxMessageLength: 4096,
    start: async () => {},
    stop: async () => {},
    send: async () => ({ ok: true }),
    onMessage: () => {},
    health: async () => healthResult,
  } as unknown as PlatformAdapter;
}

describe('buildGatewayHeartbeat', () => {
  it('includes pid, startedAt, updatedAt, and adapter statuses', async () => {
    const adapters = [
      stubAdapter('telegram:bot-1', { ok: true, latencyMs: 42 }),
      stubAdapter('slack:app-1', { ok: false }),
    ];
    const startedAt = '2026-05-20T08:00:00Z';

    const hb = await buildGatewayHeartbeat(adapters, startedAt);

    expect(hb.pid).toBe(process.pid);
    expect(hb.startedAt).toBe(startedAt);
    expect(hb.updatedAt).toBeTruthy();
    expect(hb.adapters).toEqual([
      { name: 'telegram:bot-1', ok: true },
      { name: 'slack:app-1', ok: false },
    ]);
  });

  it('marks an adapter as not-ok when health() rejects', async () => {
    const failing = stubAdapter('discord:bot', { ok: true });
    failing.health = async () => {
      throw new Error('connection refused');
    };

    const hb = await buildGatewayHeartbeat([failing], '2026-05-20T08:00:00Z');

    expect(hb.adapters).toEqual([{ name: 'discord:bot', ok: false }]);
  });

  it('marks an adapter as not-ok when health() times out', async () => {
    const hanging = stubAdapter('slow:bot', { ok: true });
    hanging.health = () => new Promise(() => {});

    const hb = await buildGatewayHeartbeat([hanging], '2026-05-20T08:00:00Z');

    expect(hb.adapters).toEqual([{ name: 'slow:bot', ok: false }]);
  }, 10_000);

  it('returns empty adapters array when no adapters are provided', async () => {
    const hb = await buildGatewayHeartbeat([], '2026-05-20T08:00:00Z');

    expect(hb.adapters).toEqual([]);
    expect(hb.pid).toBe(process.pid);
  });
});

// R9 (plan/phases/openclaw-2026.9.6-gaps.md) — the heartbeat writer runs every
// HEARTBEAT_INTERVAL_MS (10s) and `/healthz`, `/readyz` and `/metrics` each
// build a heartbeat per request, so an adapter whose `health()` is a network
// round trip (the email adapter's is a full IMAP connect + logout) was probed
// on every tick and every scrape. Results are cached per adapter for ~60s.
describe('buildGatewayHeartbeat health cache', () => {
  function countingAdapter(id: string) {
    const adapter = stubAdapter(id, { ok: true });
    let probes = 0;
    adapter.health = async () => {
      probes += 1;
      return { ok: true };
    };
    return { adapter, probes: () => probes };
  }

  it('two probes inside the window make one health() call', async () => {
    const { adapter, probes } = countingAdapter('email:inbox');
    await buildGatewayHeartbeat([adapter], '2026-05-20T08:00:00Z');
    await buildGatewayHeartbeat([adapter], '2026-05-20T08:00:00Z');
    expect(probes()).toBe(1);
  });

  it('probes again once the window has passed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const { adapter, probes } = countingAdapter('email:inbox2');
      await buildGatewayHeartbeat([adapter], '2026-05-20T08:00:00Z');
      vi.setSystemTime(Date.now() + 61_000);
      await buildGatewayHeartbeat([adapter], '2026-05-20T08:00:00Z');
      expect(probes()).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('shares one in-flight probe between concurrent callers', async () => {
    const { adapter, probes } = countingAdapter('email:inbox3');
    await Promise.all([
      buildGatewayHeartbeat([adapter], '2026-05-20T08:00:00Z'),
      buildGatewayHeartbeat([adapter], '2026-05-20T08:00:00Z'),
    ]);
    expect(probes()).toBe(1);
  });

  it('two heartbeats inside the window make one IMAP connect (email adapter)', async () => {
    const { EmailAdapter } = await import('../../../../../extensions/platform-email/src/index');
    let connects = 0;
    const imap = {
      connect: async () => {
        connects += 1;
      },
      logout: async () => {},
    };
    const adapter = new EmailAdapter(
      {
        imapHost: 'imap.example.com',
        imapPort: 993,
        user: 'agent@example.com',
        password: 'secret',
        smtpHost: 'smtp.example.com',
        smtpPort: 587,
        botKey: 'email-health-cache',
      },
      { createImapClient: () => imap as never },
    );
    await buildGatewayHeartbeat([adapter], '2026-05-20T08:00:00Z');
    await buildGatewayHeartbeat([adapter], '2026-05-20T08:00:00Z');
    expect(connects).toBe(1);
  });
});
