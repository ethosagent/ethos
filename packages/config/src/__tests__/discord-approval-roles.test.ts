// `discord.approvalRoleIds` — the Discord adapter's `role_gate` (its default
// approval policy) refuses every Approve/Deny click when no role is configured
// (`DiscordAdapter.handleApprovalDecision`), and before this key nothing in
// operator config reached `DiscordAdapterConfig.approvalRoleIds`: every Discord
// approval hung to its timeout (plan openclaw-2026.9.6-gaps S9).

import { join } from 'node:path';
import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import { type EthosConfig, ethosDir, readRawConfig, writeConfig } from '../index';

const BASE = ['provider: anthropic', 'model: m', 'apiKey: sk', 'personality: p'];

async function storageWith(lines: string[]): Promise<InMemoryStorage> {
  const storage = new InMemoryStorage();
  await storage.mkdir(ethosDir());
  await storage.write(join(ethosDir(), 'config.yaml'), [...BASE, ...lines].join('\n'));
  return storage;
}

describe('discord.approvalRoleIds', () => {
  it('parses a comma-separated role id list', async () => {
    const storage = await storageWith([
      'discord.approvalRoleIds: 1234567890123456789, 9876543210987654321',
    ]);
    const cfg = await readRawConfig(storage);
    expect(cfg?.discord?.approvalRoleIds).toEqual(['1234567890123456789', '9876543210987654321']);
  });

  it('coexists with discord.defaultChannelMode', async () => {
    const storage = await storageWith([
      'discord.defaultChannelMode: observe',
      'discord.approvalRoleIds: 111',
    ]);
    const cfg = await readRawConfig(storage);
    expect(cfg?.discord).toEqual({ defaultChannelMode: 'observe', approvalRoleIds: ['111'] });
  });

  it('round-trips through writeConfig', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    const original: EthosConfig = {
      provider: 'anthropic',
      model: 'm',
      apiKey: 'sk',
      personality: 'p',
      discord: { approvalRoleIds: ['111', '222'] },
    };
    await writeConfig(storage, original, new InMemorySecretsResolver());

    const raw = await storage.read(join(ethosDir(), 'config.yaml'));
    expect(raw).toContain('discord.approvalRoleIds: 111,222');
    expect((await readRawConfig(storage))?.discord).toEqual(original.discord);
  });
});
