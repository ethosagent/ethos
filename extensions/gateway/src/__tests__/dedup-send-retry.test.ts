// UBP-003 (plan/phases/upstream-bug-parity.md) — an agent-initiated send that
// FAILS must not arm the outbound dedup key. `sendThrough` used to record the
// key at the check (`shouldSend`), so a `send_message` retry of the same text
// inside the 30s TTL was reported `{ok:true}` ("Message sent") and nothing was
// sent. It now checks with `wouldSend` and records only after `result.ok`.

import type { AgentLoop } from '@ethosagent/core';
import type { DeliveryResult, OutboundMessage, PlatformAdapter } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { Gateway } from '../index';
import { stubLoop } from './voice-fakes';

function flakyAdapter(results: DeliveryResult[]) {
  const sent: Array<{ chatId: string; text: string }> = [];
  const adapter = {
    id: 'telegram:bot-a',
    displayName: 'Telegram',
    canSendTyping: false,
    canEditMessage: false,
    canReact: false,
    canSendFiles: false,
    maxMessageLength: 4096,
    async start() {},
    async stop() {},
    async send(chatId: string, m: OutboundMessage): Promise<DeliveryResult> {
      sent.push({ chatId, text: m.text });
      return results.shift() ?? { ok: true, messageId: String(sent.length) };
    },
    onMessage() {},
    async health() {
      return { ok: true };
    },
  } as unknown as PlatformAdapter;
  return { adapter, sent };
}

function gatewayWith(adapter: PlatformAdapter): Gateway {
  return new Gateway({
    bots: [
      {
        botKey: 'bot-a',
        loop: stubLoop() as AgentLoop,
        binding: { type: 'personality', name: 'default' },
      },
    ],
    adapters: new Map([['telegram', adapter]]),
    botAdapters: new Map([['bot-a', adapter]]),
    clarifySweepIntervalMs: 0,
    clarifyEscalationDelayMs: 0,
  });
}

describe('Gateway.sendAsBot — a failed send can be retried inside the dedup TTL (UBP-003)', () => {
  it('fail, then retry: the adapter is called twice and the retry reports the real outcome', async () => {
    const { adapter, sent } = flakyAdapter([{ ok: false, error: 'flood wait' }, { ok: true }]);
    const gw = gatewayWith(adapter);

    const first = await gw.sendAsBot('telegram', '12345', 'Deploy finished', 'bot-a');
    expect(first.ok).toBe(false);

    const retry = await gw.sendAsBot('telegram', '12345', 'Deploy finished', 'bot-a');
    expect(retry).toEqual({ ok: true });
    expect(sent).toHaveLength(2);

    // After a CONFIRMED send the same text is still a silent drop (S3).
    const third = await gw.sendAsBot('telegram', '12345', 'Deploy finished', 'bot-a');
    expect(third).toEqual({ ok: true });
    expect(sent).toHaveLength(2);
  });

  it('a send that throws does not arm the key either', async () => {
    const { adapter, sent } = flakyAdapter([]);
    let throwNext = true;
    const send = adapter.send.bind(adapter);
    (adapter as { send: PlatformAdapter['send'] }).send = async (chatId, m) => {
      if (throwNext) {
        throwNext = false;
        throw new Error('socket down');
      }
      return send(chatId, m);
    };
    const gw = gatewayWith(adapter);

    expect((await gw.sendTo('telegram', '12345', 'hello')).ok).toBe(false);
    expect(await gw.sendTo('telegram', '12345', 'hello')).toEqual({ ok: true });
    expect(sent).toHaveLength(1);
  });
});

// V-GC-1 — checking without recording opened a window: two IDENTICAL sends in
// flight at once (parallel `send_message` calls in one tool batch, a cron and a
// watcher notifying the same target) both passed the check and both reached
// the platform. `sendThrough` now reserves the key at the check, releases it
// on failure and commits it on success; a duplicate that arrives while the
// first is in flight shares that send's outcome.
describe('Gateway.sendAsBot — concurrent identical sends (V-GC-1)', () => {
  function gatedAdapter() {
    const { adapter, sent } = flakyAdapter([]);
    const gates: Array<(r: DeliveryResult) => void> = [];
    (adapter as { send: PlatformAdapter['send'] }).send = (chatId, m) => {
      sent.push({ chatId, text: m.text });
      return new Promise<DeliveryResult>((resolve) => gates.push(resolve));
    };
    return { adapter, sent, gates };
  }

  it('two identical sends in flight at once reach the platform once', async () => {
    const { adapter, sent, gates } = gatedAdapter();
    const gw = gatewayWith(adapter);

    const a = gw.sendAsBot('telegram', '12345', 'Deploy finished', 'bot-a');
    const b = gw.sendAsBot('telegram', '12345', 'Deploy finished', 'bot-a');
    await new Promise((r) => setImmediate(r));
    expect(sent).toHaveLength(1);
    gates[0]?.({ ok: true, messageId: '1' });
    expect(await a).toEqual({ ok: true });
    expect(await b).toEqual({ ok: true });
    expect(sent).toHaveLength(1);
  });

  it('when the in-flight send fails, the duplicate reports that failure and a retry goes out', async () => {
    const { adapter, sent, gates } = gatedAdapter();
    const gw = gatewayWith(adapter);

    const a = gw.sendAsBot('telegram', '12345', 'Deploy finished', 'bot-a');
    const b = gw.sendAsBot('telegram', '12345', 'Deploy finished', 'bot-a');
    await new Promise((r) => setImmediate(r));
    gates[0]?.({ ok: false, error: 'flood wait' });
    expect((await a).ok).toBe(false);
    expect((await b).ok).toBe(false);
    expect(sent).toHaveLength(1);

    // The failure released the reservation: a retry is sent, not swallowed.
    const retry = gw.sendAsBot('telegram', '12345', 'Deploy finished', 'bot-a');
    await new Promise((r) => setImmediate(r));
    gates[1]?.({ ok: true });
    expect(await retry).toEqual({ ok: true });
    expect(sent).toHaveLength(2);
  });
});
