import { ethosDir, readConfig, readRawConfig, writeConfig } from '@ethosagent/config';
import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import type { SecretsResolver, Storage } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Re-running `ethos setup` (or one step of it) seeds the TUI wizard with the
// config ON DISK, whose credentials are `${secrets:…}` references. Handing an
// answer back unchanged must keep the stored key — not store the reference
// string AS the key, which is what `storeSecret` did.

const wiring = vi.hoisted(() => ({}) as { storage?: Storage; secrets?: SecretsResolver });

vi.mock('../../wiring', () => ({
  getStorage: () => wiring.storage,
  getSecretsResolver: async () => wiring.secrets,
  getFunnelTracker: () => ({ recordSetupCompleted: async () => {} }),
}));

// The wizard returns the answers it was seeded with: the operator changed nothing.
// The readline fallback probes the key before writing; never over the network.
vi.mock('@ethosagent/wiring', () => ({ probeProvider: async () => ({ ok: true }) }));

const prompts = vi.hoisted(() => ({ answers: [] as string[] }));

vi.mock('node:readline', () => ({
  createInterface: () => ({
    question: (_p: string, cb: (a: string) => void) => cb(prompts.answers.shift() ?? ''),
    close: () => {},
  }),
}));

vi.mock('@ethosagent/tui/setup', () => ({
  runSetupWizard: async (opts: { existing: Record<string, unknown> | null }) => ({
    answers: { ...(opts.existing ?? {}) },
    launch: 'done',
  }),
}));

describe('ethos setup re-run keeps stored credentials', () => {
  let stdinTTY: boolean | undefined;
  let stdoutTTY: boolean | undefined;

  beforeEach(() => {
    stdinTTY = process.stdin.isTTY;
    stdoutTTY = process.stdout.isTTY;
    process.stdin.isTTY = true;
    process.stdout.isTTY = true;
  });

  afterEach(() => {
    process.stdin.isTTY = stdinTTY ?? false;
    process.stdout.isTTY = stdoutTTY ?? false;
  });

  it('does not overwrite a stored key with its own reference', async () => {
    const storage = new InMemoryStorage();
    const secrets = new InMemorySecretsResolver();
    await storage.mkdir(ethosDir());
    await writeConfig(
      storage,
      {
        provider: 'anthropic',
        model: 'claude-opus-4-7',
        apiKey: 'sk-ant-top-0123456789',
        personality: 'researcher',
        telegramToken: '123:telegram-token',
        providers: [
          { provider: 'openai', apiKey: 'sk-openai-0123456789' },
          { provider: 'bedrock', apiKey: '', region: 'eu-west-1', passthrough: { fooBar: 'x' } },
        ],
      },
      secrets,
    );
    wiring.storage = storage;
    wiring.secrets = secrets;

    const { runSetup } = await import('../setup');
    await runSetup();

    const resolved = await readConfig(storage, secrets);
    expect(resolved?.apiKey).toBe('sk-ant-top-0123456789');
    expect(resolved?.telegramToken).toBe('123:telegram-token');
    expect(resolved?.providers?.map((p) => p.apiKey)).toEqual(['sk-openai-0123456789', '']);
    // And the chain's other fields ride along.
    expect((await readRawConfig(storage))?.providers?.[1]).toMatchObject({
      region: 'eu-west-1',
      passthrough: { fooBar: 'x' },
    });
  });

  // The readline fallback (no TTY) used to build a fresh config from the
  // answers alone, so the whole `providers:` chain — which `writeConfig` does
  // not preserve as unexpressible lines — was deleted, with its vault secrets
  // left behind. It must round-trip everything it did not ask about, exactly
  // as the TUI path does.
  it('the readline fallback keeps the chain it never asked about', async () => {
    const storage = new InMemoryStorage();
    const secrets = new InMemorySecretsResolver();
    await storage.mkdir(ethosDir());
    await writeConfig(
      storage,
      {
        provider: 'anthropic',
        model: 'claude-opus-4-7',
        apiKey: 'sk-ant-old-0123456789',
        personality: 'researcher',
        telegramToken: '123:telegram-token',
        providers: [
          { provider: 'anthropic', apiKey: 'sk-ant-chain-0123456789' },
          { provider: 'bedrock', apiKey: '', region: 'eu-west-1', passthrough: { fooBar: 'x' } },
        ],
      },
      secrets,
    );
    wiring.storage = storage;
    wiring.secrets = secrets;
    process.stdin.isTTY = false;
    process.stdout.isTTY = false;
    // overwrite? · provider · model · API key · personality
    prompts.answers = ['y', 'anthropic', 'claude-sonnet-5', 'sk-ant-new-0123456789', 'engineer'];

    const { runSetup } = await import('../setup');
    await runSetup();

    const resolved = await readConfig(storage, secrets);
    expect(resolved?.model).toBe('claude-sonnet-5');
    expect(resolved?.personality).toBe('engineer');
    expect(resolved?.apiKey).toBe('sk-ant-new-0123456789');
    expect(resolved?.telegramToken).toBe('123:telegram-token');
    expect(resolved?.providers?.map((p) => [p.provider, p.apiKey])).toEqual([
      ['anthropic', 'sk-ant-chain-0123456789'],
      ['bedrock', ''],
    ]);
    expect((await readRawConfig(storage))?.providers?.[1]).toMatchObject({
      region: 'eu-west-1',
      passthrough: { fooBar: 'x' },
    });
  });
});
