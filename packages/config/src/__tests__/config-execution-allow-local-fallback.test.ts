// S6 / D3 (plan openclaw-2026.9.6-gaps) — `execution.allowLocalFallback`, the
// operator's opt-in to run exec personalities un-sandboxed on the host when no
// Docker backend can be built in this process. Refused without it
// (`resolveExecutionPosture`, packages/wiring/src/resolve-execution-posture.ts).

import { join } from 'node:path';
import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import { ethosDir, readRawConfig, writeConfig } from '../index';

describe('execution.allowLocalFallback config parsing', () => {
  async function load(yaml: string) {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    await storage.write(join(ethosDir(), 'config.yaml'), yaml);
    return readRawConfig(storage);
  }

  const base = ['provider: ollama', 'model: llama3.2', 'apiKey: sk', 'personality: p'];

  it('parses true', async () => {
    const cfg = await load([...base, 'execution.allowLocalFallback: true'].join('\n'));
    expect(cfg?.execution).toEqual({ allowLocalFallback: true });
  });

  it('treats anything but true as unset (the refusal stays the default)', async () => {
    for (const value of ['false', 'yes', '1']) {
      const cfg = await load([...base, `execution.allowLocalFallback: ${value}`].join('\n'));
      expect(cfg?.execution?.allowLocalFallback).toBeUndefined();
    }
  });

  it('sits beside the docker caps', async () => {
    const cfg = await load(
      [...base, 'execution.docker.cpu: 2', 'execution.allowLocalFallback: true'].join('\n'),
    );
    expect(cfg?.execution).toEqual({ docker: { cpu: 2 }, allowLocalFallback: true });
  });

  it('round-trips through writeConfig', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    const original = {
      provider: 'ollama',
      model: 'llama3.2',
      apiKey: 'sk',
      personality: 'researcher',
      execution: { allowLocalFallback: true },
    };
    await writeConfig(storage, original, new InMemorySecretsResolver());
    const roundTripped = await readRawConfig(storage);
    expect(roundTripped?.execution).toEqual(original.execution);
  });
});
