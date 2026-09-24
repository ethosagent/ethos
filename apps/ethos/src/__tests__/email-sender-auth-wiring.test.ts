// Item 6 (plan openclaw-advisory-fixes) — `emailTrustedAuthservId` reaches the
// email adapter at every construction site, and its absence is announced at boot.
//
// `buildAdapters` is the ONE place an `EmailAdapter` is constructed: `ethos
// gateway start` and `ethos boot` reach it through `buildGatewayAdapters`, and
// both hosts' live bot add/replace build from `sliceConfigForBot` through the
// same function. So threading is pinned here once, plus the slice and the
// hot-reload fingerprint that decide whether an edited key is rebuilt.

import type { EthosConfig } from '@ethosagent/config';
import type { InboundMessage, PlatformAdapter } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import {
  type AdapterModuleLoader,
  buildAdapters,
  warnEmailSenderAuthUnconfigured,
} from '../commands/gateway';
import { appliedStateOf, planReconcile, sliceConfigForBot } from '../config-reload';

interface Captured extends PlatformAdapter {
  capturedConfig: Record<string, unknown>;
}

const loader: AdapterModuleLoader = async <T>(modulePath: string): Promise<T | null> => {
  if (modulePath !== '@ethosagent/platform-email') return null;
  return {
    EmailAdapter: class {
      constructor(cfg: Record<string, unknown>) {
        const adapter: Captured = {
          id: `email:${String(cfg.botKey)}`,
          displayName: 'email',
          canSendTyping: false,
          canEditMessage: false,
          canReact: false,
          canSendFiles: false,
          maxMessageLength: 100_000,
          capturedConfig: cfg,
          async start() {},
          async stop() {},
          async send() {
            return { ok: true };
          },
          onMessage(_h: (m: InboundMessage) => void) {},
          async health() {
            return { ok: true };
          },
        };
        Object.assign(this, adapter);
      }
    },
  } as T;
};

const emailConfig: EthosConfig = {
  provider: 'anthropic',
  model: 'claude-opus-4-7',
  apiKey: 'sk',
  personality: 'researcher',
  emailImapHost: 'imap.example.com',
  emailUser: 'me@example.com',
  emailPassword: 'pw',
  emailSmtpHost: 'smtp.example.com',
};

async function builtEmailConfig(config: EthosConfig): Promise<Record<string, unknown>> {
  const adapters = await buildAdapters(config, loader);
  expect(adapters).toHaveLength(1);
  return (adapters[0] as Captured).capturedConfig;
}

describe('emailTrustedAuthservId wiring', () => {
  it('buildAdapters threads the key into EmailAdapterConfig.trustedAuthservId', async () => {
    const cfg = await builtEmailConfig({
      ...emailConfig,
      emailTrustedAuthservId: 'mx.example.com',
    });
    expect(cfg.trustedAuthservId).toBe('mx.example.com');
  });

  it('buildAdapters leaves trustedAuthservId absent when the key is unset', async () => {
    const cfg = await builtEmailConfig(emailConfig);
    expect('trustedAuthservId' in cfg).toBe(false);
  });

  it('the live-add slice for the email bot keeps the key, so a hot-added bot is built with it', async () => {
    const source = { ...emailConfig, emailTrustedAuthservId: 'mx.example.com' };
    const botId = [...appliedStateOf(source).bots.keys()].find((id) => id.startsWith('email:'));
    expect(botId).toBeDefined();
    const slice = sliceConfigForBot(source, botId ?? '');
    expect(slice?.emailTrustedAuthservId).toBe('mx.example.com');
    const cfg = await builtEmailConfig(slice ?? emailConfig);
    expect(cfg.trustedAuthservId).toBe('mx.example.com');
  });

  it('editing the key marks the email bot changed, so it is replaced live rather than ignored', () => {
    const applied = appliedStateOf(emailConfig);
    const plan = planReconcile(applied, {
      ...emailConfig,
      emailTrustedAuthservId: 'mx.example.com',
    });
    expect(plan.bots.changed).toHaveLength(1);
    expect(plan.bots.changed[0]?.startsWith('email:')).toBe(true);
    // Unchanged config → nothing to do (the new fingerprint field is stable).
    expect(planReconcile(applied, emailConfig).bots.changed).toEqual([]);
  });
});

describe('warnEmailSenderAuthUnconfigured', () => {
  function run(config: EthosConfig) {
    const records: Array<{ code: string; cause: string; severity: string }> = [];
    const logs: string[] = [];
    const warned = warnEmailSenderAuthUnconfigured(
      config,
      (opts) => records.push(opts),
      (line) => logs.push(line),
    );
    return { warned, records, logs };
  }

  it('records one warn-level event and one console line when email has no key', () => {
    const { warned, records, logs } = run(emailConfig);
    expect(warned).toBe(true);
    expect(records).toEqual([
      expect.objectContaining({ code: 'email.sender_auth_unconfigured', severity: 'warn' }),
    ]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('emailTrustedAuthservId');
  });

  it('is silent when the key is set, or when email is not configured', () => {
    for (const config of [
      { ...emailConfig, emailTrustedAuthservId: 'mx.example.com' },
      { ...emailConfig, emailImapHost: undefined },
    ]) {
      const { warned, records, logs } = run(config);
      expect(warned).toBe(false);
      expect(records).toEqual([]);
      expect(logs).toEqual([]);
    }
  });

  it('treats a whitespace-only key as unset', () => {
    expect(run({ ...emailConfig, emailTrustedAuthservId: '  ' }).warned).toBe(true);
  });

  it('a throwing observability sink does not stop the boot', () => {
    const logs: string[] = [];
    expect(
      warnEmailSenderAuthUnconfigured(
        emailConfig,
        () => {
          throw new Error('store closed');
        },
        (line) => logs.push(line),
      ),
    ).toBe(true);
    expect(logs).toHaveLength(1);
  });
});
