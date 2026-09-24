// openclaw-9.5 item 1 (D14) — a channel lane never accepts a secret as message
// text, DM or group. A turn refused pre-turn for a missing plugin credential
// gets a link to the web plugin-credentials page (or, with no `webBaseUrl`,
// the CLI command), sent on the tracked reply path, and the user's next message
// is an ordinary turn — never stored as a credential.

import type { AgentLoop } from '@ethosagent/core';
import { DefaultHookRegistry } from '@ethosagent/core';
import { SQLiteDeliveryLedger } from '@ethosagent/delivery-ledger';
import { describe, expect, it, vi } from 'vitest';
import { credentialRequiredReply } from '../credential-reply';
import { Gateway } from '../index';
import { fakeAdapter, inbound } from './voice-fakes';

const PENDING = 'what is the forecast for Lisbon?';

/** A loop that refuses every opted-in turn for a missing credential. */
function refusingLoop() {
  const calls: Array<{ text: string; opts: Record<string, unknown> }> = [];
  const loop = {
    hooks: new DefaultHookRegistry(),
    run: vi.fn(async function* (text: string, opts: Record<string, unknown>) {
      calls.push({ text, opts });
      if (opts.credentialPrompt === true) {
        yield {
          type: 'credential_required' as const,
          pluginId: 'weather',
          credentialKey: 'API_KEY',
          kind: 'api_key' as const,
          label: 'Weather API key',
          sessionKey: String(opts.sessionKey),
          pendingUserMessage: text,
        };
        yield { type: 'done' as const, text: '', turnCount: 0 };
        return;
      }
      yield { type: 'done' as const, text: 'ran', turnCount: 1 };
    }),
  } as unknown as AgentLoop;
  return { loop, calls };
}

function gatewayFor(opts: { webBaseUrl?: string; ledger?: SQLiteDeliveryLedger }) {
  const r = refusingLoop();
  const setCredential = vi.fn(async () => {});
  const gw = new Gateway({
    bots: [{ botKey: 'bot-a', loop: r.loop, binding: { type: 'personality', name: 'default' } }],
    clarifySweepIntervalMs: 0,
    ...(opts.webBaseUrl ? { webBaseUrl: opts.webBaseUrl } : {}),
    ...(opts.ledger ? { deliveryLedger: opts.ledger } : {}),
    // A loader IS wired, so "never calls setCredential" below is a real claim.
    pluginLoader: { setCredential, getPlatformAdapters: () => new Map() } as never,
  });
  return { gw, ...r, setCredential };
}

describe('gateway credential_required', () => {
  it('opts user turns in and replies with a link to the plugin credentials page', async () => {
    const ledger = new SQLiteDeliveryLedger(':memory:');
    const adapter = fakeAdapter({ platform: 'telegram' });
    const { gw, calls } = gatewayFor({ webBaseUrl: 'https://ethos.example.com/app/', ledger });

    await gw.handleMessage(inbound({ text: PENDING }), adapter.adapter);

    expect(calls[0]?.opts.credentialPrompt).toBe(true);
    expect(adapter.sent).toHaveLength(1);
    const text = adapter.sent[0]?.message.text ?? '';
    expect(text).toContain('https://ethos.example.com/app/plugins?pluginId=weather&key=API_KEY');
    expect(text).toContain("don't accept credentials in chat");
    // The reply never quotes the user's message back.
    expect(text).not.toContain(PENDING);
    // Tracked: one obligation, confirmed by the adapter.
    const rows = await ledger.findBySession(String(calls[0]?.opts.sessionKey));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('delivered');
    ledger.close();
  });

  it('with no webBaseUrl names the CLI command instead of guessing a URL', async () => {
    const adapter = fakeAdapter({ platform: 'telegram' });
    const { gw } = gatewayFor({});

    await gw.handleMessage(inbound({ text: PENDING }), adapter.adapter);

    const text = adapter.sent[0]?.message.text ?? '';
    expect(text).toContain('ethos plugin credentials weather --set API_KEY');
    expect(text).not.toContain('http');
  });

  it('a pasted secret afterwards is an ordinary turn, never stored as a credential', async () => {
    const adapter = fakeAdapter({ platform: 'telegram' });
    const { gw, calls, setCredential } = gatewayFor({ webBaseUrl: 'https://ethos.example.com' });

    await gw.handleMessage(inbound({ text: PENDING }), adapter.adapter);
    await gw.handleMessage(inbound({ text: 'sk-live-PASTED-9999' }), adapter.adapter);

    expect(setCredential).not.toHaveBeenCalled();
    // The second message went to the loop as message text, like any other.
    expect(calls[1]?.text).toContain('sk-live-PASTED-9999');
    // Nothing the gateway sent echoes it.
    for (const s of adapter.sent) expect(s.message.text).not.toContain('sk-live-PASTED-9999');
  });

  it('refuses a non-http webBaseUrl rather than linking to it', () => {
    const req = { pluginId: 'weather', credentialKey: 'API_KEY', label: 'k' };
    expect(credentialRequiredReply(req, 'javascript:alert(1)')).toContain(
      'ethos plugin credentials weather --set API_KEY',
    );
    // Query values are encoded, never spliced raw into the URL.
    expect(
      credentialRequiredReply(
        { pluginId: 'weather', credentialKey: 'A&B', label: 'k' },
        'https://x.example',
      ),
    ).toContain('key=A%26B');
  });
});
