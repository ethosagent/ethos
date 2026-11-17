// WIRING lane, dispatch maps (§2b / §3c) — split from the original gateway-platform-webhook-wiring.test.ts;
// see plan/phases/telegram-slack-webhook-mode.md. Shared stubs: ./gateway-platform-webhook-wiring.fixtures

import type { EthosConfig } from '@ethosagent/config';
import { describe, expect, it } from 'vitest';
import { buildAdapters, buildPlatformWebhookMounts } from '../commands/gateway';
import { baseConfig, makeLoader, startAll } from './gateway-platform-webhook-wiring.fixtures';

// ---------------------------------------------------------------------------
// §2b / §3c — the dispatch maps.
// ---------------------------------------------------------------------------

describe('buildPlatformWebhookMounts', () => {
  const webhookConfig: EthosConfig = {
    ...baseConfig,
    telegram: {
      bots: [
        {
          id: 'tg-a',
          token: '1:a',
          bind: { type: 'personality', name: 'researcher' },
          useWebhook: true,
          webhookUrl: 'https://ethos.example/telegram/webhook/tg-a',
          webhookSecretToken: 'a',
        },
        // Long-poll bot sharing the process — must NOT be mounted.
        { id: 'tg-b', token: '2:b', bind: { type: 'personality', name: 'coder' } },
      ],
    },
    slack: {
      apps: [
        {
          id: 'sl-a',
          botToken: 'xoxb-a',
          signingSecret: 'sig-a',
          bind: { type: 'personality', name: 'researcher' },
          mode: { http: true },
        },
        // Socket-mode app sharing the process — must NOT be mounted.
        {
          id: 'sl-b',
          botToken: 'xoxb-b',
          appToken: 'xapp-b',
          signingSecret: 'sig-b',
          bind: { type: 'personality', name: 'coder' },
        },
      ],
    },
  };

  it('populates both maps with the right keys, and only for bots that asked', async () => {
    const adapters = await buildAdapters(webhookConfig, makeLoader());
    await startAll(adapters);
    const warnings: string[] = [];
    const mounts = buildPlatformWebhookMounts(webhookConfig, adapters, (m) => warnings.push(m));

    // Telegram is keyed by botKey; the server appends it to
    // `/telegram/webhook/`.
    expect([...mounts.telegram.keys()]).toEqual(['tg-a']);
    // Slack is keyed by the FULL route the adapter reports, never recomputed.
    expect([...mounts.slack.keys()]).toEqual(['/slack/events/sl-a']);
    expect(typeof mounts.telegram.get('tg-a')).toBe('function');
    expect(typeof mounts.slack.get('/slack/events/sl-a')).toBe('function');
    expect(warnings).toEqual([]);
  });

  it('keys Slack by the adapter’s webhookPath override rather than its botKey', async () => {
    const config: EthosConfig = {
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
    };
    const adapters = await buildAdapters(config, makeLoader());
    await startAll(adapters);
    const mounts = buildPlatformWebhookMounts(config, adapters, () => {});
    expect([...mounts.slack.keys()]).toEqual(['/slack/events/events-prod']);
  });

  it('warns and registers nothing when a webhook-mode Telegram bot exposes no handler', async () => {
    const config: EthosConfig = {
      ...baseConfig,
      telegram: {
        bots: [
          {
            id: 'tg-broken',
            token: '1:t',
            bind: { type: 'personality', name: 'researcher' },
            useWebhook: true,
            webhookUrl: 'https://ethos.example/telegram/webhook/tg-broken',
            webhookSecretToken: 's',
          },
        ],
      },
    };
    const adapters = await buildAdapters(config, makeLoader());
    // Deliberately NOT started — this is exactly the shape a caller that built
    // the maps too early would produce, and the shape a real adapter whose
    // `setWebhook` failed would leave behind.
    const warnings: string[] = [];
    const mounts = buildPlatformWebhookMounts(config, adapters, (m) => warnings.push(m));

    expect(mounts.telegram.size).toBe(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('tg-broken');
    expect(warnings[0]).toContain('use_webhook');
  });

  it('resolves the same derived botKey the adapters were built on when `id` is omitted', async () => {
    const config: EthosConfig = {
      ...baseConfig,
      telegram: {
        bots: [
          {
            token: '123:ABC',
            bind: { type: 'personality', name: 'researcher' },
            useWebhook: true,
            webhookUrl: 'https://ethos.example/telegram/webhook/x',
            webhookSecretToken: 's',
          },
        ],
      },
    };
    const adapters = await buildAdapters(config, makeLoader());
    await startAll(adapters);
    const warnings: string[] = [];
    const mounts = buildPlatformWebhookMounts(config, adapters, (m) => warnings.push(m));

    expect(warnings).toEqual([]);
    expect([...mounts.telegram.keys()]).toEqual([adapters[0].id.replace('telegram:', '')]);
  });
});
