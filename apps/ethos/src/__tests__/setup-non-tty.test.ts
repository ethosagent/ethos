// biome-ignore-all lint/suspicious/noTemplateCurlyInString: `${secrets:…}` refs are literal config text, not templates
// Acceptance gate: runSetup() takes the readline fallback when stdin/stdout
// are not TTYs — the Ink wizard must never be imported in non-TTY environments.
// Plus B4 (plan ux-feedback-and-config-clarity): the wizard's channel answers
// serialize as the `telegram.bots.0.*` / `slack.apps.0.*` list forms, never
// the deprecated scalar keys.

import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../wiring', () => ({
  getStorage: () => ({}),
  getSecretsResolver: async () => ({}),
  getFunnelTracker: () => ({ recordSetupCompleted: async () => {} }),
}));

import { loadConfigStrict, writeConfig } from '@ethosagent/config';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import type { SecretRef, SecretsResolver } from '@ethosagent/types';
import { channelListConfig } from '../commands/setup';

class MapSecrets implements SecretsResolver {
  readonly store = new Map<string, string>();
  async get(ref: SecretRef): Promise<string | null> {
    return this.store.get(ref) ?? null;
  }
  async set(ref: SecretRef, value: string): Promise<void> {
    this.store.set(ref, value);
  }
  async delete(ref: SecretRef): Promise<void> {
    this.store.delete(ref);
  }
  async list(prefix?: string): Promise<SecretRef[]> {
    return [...this.store.keys()].filter((r) => !prefix || r.startsWith(prefix));
  }
}

describe('runSetup non-TTY path', () => {
  let originalStdinIsTTY: boolean | undefined;
  let originalStdoutIsTTY: boolean | undefined;

  beforeEach(() => {
    originalStdinIsTTY = process.stdin.isTTY;
    originalStdoutIsTTY = process.stdout.isTTY;
    process.stdin.isTTY = false;
    process.stdout.isTTY = false;
  });

  afterEach(() => {
    process.stdin.isTTY = originalStdinIsTTY ?? false;
    process.stdout.isTTY = originalStdoutIsTTY ?? false;
    vi.restoreAllMocks();
  });

  it('isTTY override works (test fixture sanity)', () => {
    expect(process.stdin.isTTY).toBe(false);
    expect(process.stdout.isTTY).toBe(false);
  });

  it('setup.ts source guards Ink import behind TTY check', () => {
    const { readFileSync } = require('node:fs');
    const { join } = require('node:path');
    const src = readFileSync(
      join(import.meta.dirname, '..', 'commands', 'setup.ts'),
      'utf8',
    ) as string;

    // The dynamic import of @ethosagent/tui/setup must only appear inside the
    // `if (process.stdin.isTTY && process.stdout.isTTY)` block.
    const tuiImportIndex = src.indexOf("import('@ethosagent/tui/setup')");
    const ttyCheckIndex = src.indexOf('process.stdin.isTTY && process.stdout.isTTY');

    expect(tuiImportIndex).toBeGreaterThan(-1);
    expect(ttyCheckIndex).toBeGreaterThan(-1);
    // TTY guard must appear before the dynamic import in source order
    expect(ttyCheckIndex).toBeLessThan(tuiImportIndex);
  });
});

describe('B4 — setup writes the bot list forms', () => {
  const STATE_DIR = '/tmp/ethos-setup-b4-test';
  let priorStateDir: string | undefined;

  beforeEach(() => {
    priorStateDir = process.env.ETHOS_STATE_DIR;
    process.env.ETHOS_STATE_DIR = STATE_DIR;
  });

  afterEach(() => {
    if (priorStateDir === undefined) delete process.env.ETHOS_STATE_DIR;
    else process.env.ETHOS_STATE_DIR = priorStateDir;
  });

  it('serializes telegram.bots.0.* / slack.apps.0.* and no legacy keys, with zero deprecations', async () => {
    const storage = new InMemoryStorage();
    const secrets = new MapSecrets();
    const channels = await channelListConfig(
      {
        telegramToken: '123:ABC',
        slackBotToken: 'xoxb-1',
        slackAppToken: 'xapp-1',
        slackSigningSecret: 'sig-1',
      },
      null,
      secrets,
      { type: 'personality', name: 'researcher' },
    );
    await writeConfig(
      storage,
      {
        provider: 'anthropic',
        model: 'claude-sonnet-5',
        apiKey: '',
        personality: 'researcher',
        ...channels,
      },
      secrets,
    );

    const text = await storage.read(join(STATE_DIR, 'config.yaml'));
    expect(text).toBeTruthy();
    const written = text ?? '';
    expect(written).toContain('telegram.bots.0.token: ${secrets:telegram/token}');
    expect(written).toContain('telegram.bots.0.bind.type: personality');
    expect(written).toContain('telegram.bots.0.bind.name: researcher');
    expect(written).toContain('slack.apps.0.botToken: ${secrets:slack/botToken}');
    expect(written).toContain('slack.apps.0.appToken: ${secrets:slack/appToken}');
    expect(written).toContain('slack.apps.0.signingSecret: ${secrets:slack/signingSecret}');
    expect(written).toContain('slack.apps.0.bind.name: researcher');
    expect(written).not.toContain('telegramToken:');
    expect(written).not.toContain('slackBotToken:');
    expect(written).not.toContain('slackAppToken:');
    expect(written).not.toContain('slackSigningSecret:');
    // The raw values landed in the vault; only refs reached the file.
    expect(secrets.store.get('telegram/token')).toBe('123:ABC');
    expect(written).not.toContain('123:ABC');

    const loaded = await loadConfigStrict(storage);
    expect(loaded).not.toBeNull();
    expect(loaded?.parseErrors).toEqual([]);
    expect(loaded?.deprecations).toEqual([]);
  });

  it('carries an existing list over when the wizard answer is blank', async () => {
    const secrets = new MapSecrets();
    const existing = {
      telegram: {
        bots: [
          {
            token: '${secrets:telegram/token}',
            bind: { type: 'personality' as const, name: 'coach' },
          },
        ],
      },
    };
    const channels = await channelListConfig({}, existing, secrets, {
      type: 'personality',
      name: 'researcher',
    });
    expect(channels.telegram).toEqual(existing.telegram);
    expect(channels.slack).toBeUndefined();
  });
});
