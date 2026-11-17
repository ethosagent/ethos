// WIRING lane, config → adapter constructor (§9, §2a, §3b) — split from the original gateway-platform-webhook-wiring.test.ts;
// see plan/phases/telegram-slack-webhook-mode.md. Shared stubs: ./gateway-platform-webhook-wiring.fixtures

import type { EthosConfig } from '@ethosagent/config';
import { describe, expect, it } from 'vitest';
import { readGatewaySources } from '../commands/__tests__/gateway-sources';
import { buildAdapters, buildPlatformWebhookMounts } from '../commands/gateway';
import {
  baseConfig,
  capturedOf,
  makeLoader,
  startAll,
} from './gateway-platform-webhook-wiring.fixtures';

// ---------------------------------------------------------------------------
// §9 "Default-preserving test" — the most important one in this lane.
// ---------------------------------------------------------------------------

describe('§9 default-preserving — no new config key set anywhere', () => {
  it('constructs the Telegram adapter with no useWebhook and the Slack adapter in Socket Mode', async () => {
    const adapters = await buildAdapters(
      {
        ...baseConfig,
        telegram: {
          bots: [{ id: 'tg', token: '1:t', bind: { type: 'personality', name: 'researcher' } }],
        },
        slack: {
          apps: [
            {
              id: 'sl',
              botToken: 'xoxb',
              appToken: 'xapp',
              signingSecret: 'sig',
              bind: { type: 'personality', name: 'researcher' },
            },
          ],
        },
      },
      makeLoader(),
    );

    const telegram = capturedOf(adapters[0]);
    // Not `false` — absent. The adapter's own `!!this.config.useWebhook` and
    // the long-poll `else` branch are what today's deployments run.
    expect(telegram).not.toHaveProperty('useWebhook');
    expect(telegram).not.toHaveProperty('webhookUrl');
    expect(telegram).not.toHaveProperty('webhookSecretToken');
    // Passed through as `undefined`, which the adapter resolves to `false` via
    // its own `?? false` (D3 — queued updates survive a restart;
    // `TelegramAdapter` constructor) — see the `dropPendingUpdates` block below.
    expect(telegram.dropPendingUpdates).toBeUndefined();

    const slack = capturedOf(adapters[1]);
    expect(slack).not.toHaveProperty('mode');
    expect(slack).not.toHaveProperty('webhookPath');
    expect(slack.appToken).toBe('xapp');
  });

  it('mounts nothing, so no platform webhook port is ever bound', async () => {
    const config: EthosConfig = {
      ...baseConfig,
      telegram: {
        bots: [{ id: 'tg', token: '1:t', bind: { type: 'personality', name: 'researcher' } }],
      },
      slack: {
        apps: [
          {
            id: 'sl',
            botToken: 'xoxb',
            appToken: 'xapp',
            signingSecret: 'sig',
            bind: { type: 'personality', name: 'researcher' },
          },
        ],
      },
    };
    const adapters = await buildAdapters(config, makeLoader());
    await startAll(adapters);

    const warnings: string[] = [];
    const mounts = buildPlatformWebhookMounts(config, adapters, (m) => warnings.push(m));

    // The gate `runGatewayStart` reads: both empty ⇒ `createPlatformWebhookServer`
    // is never called and nothing listens.
    expect(mounts.telegram.size).toBe(0);
    expect(mounts.slack.size).toBe(0);
    expect(warnings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// §9 Telegram config plumbing + the dropPendingUpdates regression.
// ---------------------------------------------------------------------------

describe('§2a Telegram webhook config reaches the adapter constructor', () => {
  it('threads useWebhook / webhookUrl / webhookSecretToken through', async () => {
    const adapters = await buildAdapters(
      {
        ...baseConfig,
        telegram: {
          bots: [
            {
              id: 'tg',
              token: '1:t',
              bind: { type: 'personality', name: 'researcher' },
              useWebhook: true,
              webhookUrl: 'https://ethos.example/telegram/webhook/tg',
              webhookSecretToken: 'shhh',
            },
          ],
        },
      },
      makeLoader(),
    );

    expect(capturedOf(adapters[0])).toMatchObject({
      token: '1:t',
      botKey: 'tg',
      useWebhook: true,
      webhookUrl: 'https://ethos.example/telegram/webhook/tg',
      webhookSecretToken: 'shhh',
    });
  });

  it('threads an explicit useWebhook: false through rather than dropping it', async () => {
    const adapters = await buildAdapters(
      {
        ...baseConfig,
        telegram: {
          bots: [
            {
              id: 'tg',
              token: '1:t',
              bind: { type: 'personality', name: 'researcher' },
              useWebhook: false,
            },
          ],
        },
      },
      makeLoader(),
    );
    expect(capturedOf(adapters[0]).useWebhook).toBe(false);
  });

  it('threads a non-default dropPendingUpdates: false from config (regression — was hardcoded `true`)', async () => {
    const adapters = await buildAdapters(
      {
        ...baseConfig,
        telegram: {
          bots: [
            {
              id: 'tg',
              token: '1:t',
              bind: { type: 'personality', name: 'researcher' },
              dropPendingUpdates: false,
            },
          ],
        },
      },
      makeLoader(),
    );
    // Before this lane the construction site passed the literal `true`, so an
    // operator's `false` was silently discarded and every queued update was
    // dropped on restart anyway.
    expect(capturedOf(adapters[0]).dropPendingUpdates).toBe(false);
  });

  it('does not double-default dropPendingUpdates — the adapter owns the `?? false`', async () => {
    const src = readGatewaySources();
    expect(src).toMatch(/dropPendingUpdates: botCfg\.dropPendingUpdates,/);
    expect(src).not.toMatch(/dropPendingUpdates: botCfg\.dropPendingUpdates \?\?/);
  });
});

// ---------------------------------------------------------------------------
// §9 Slack config plumbing.
// ---------------------------------------------------------------------------

describe('§3b Slack transport config reaches the adapter constructor', () => {
  it('threads mode and webhookPath through', async () => {
    const adapters = await buildAdapters(
      {
        ...baseConfig,
        slack: {
          apps: [
            {
              id: 'sl',
              botToken: 'xoxb',
              signingSecret: 'sig',
              bind: { type: 'personality', name: 'researcher' },
              mode: { http: true },
              webhookPath: 'events-prod',
            },
          ],
        },
      },
      makeLoader(),
    );

    expect(capturedOf(adapters[0])).toMatchObject({
      botToken: 'xoxb',
      signingSecret: 'sig',
      botKey: 'sl',
      mode: { http: true },
      webhookPath: 'events-prod',
    });
  });

  it('constructs an HTTP-mode app that has no appToken at all', async () => {
    const adapters = await buildAdapters(
      {
        ...baseConfig,
        slack: {
          apps: [
            {
              id: 'sl',
              botToken: 'xoxb',
              signingSecret: 'sig',
              bind: { type: 'personality', name: 'researcher' },
              mode: { socket: false, http: true },
            },
          ],
        },
      },
      makeLoader(),
    );
    expect(adapters).toHaveLength(1);
    expect(capturedOf(adapters[0]).appToken).toBeUndefined();
  });
});
