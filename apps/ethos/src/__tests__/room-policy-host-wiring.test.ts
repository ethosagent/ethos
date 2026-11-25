// Both gateway hosts must hand `buildGateway` the per-room policy table
// (plan channel-prompts D9). `ethos boot` once forgot (boot.ts built the Gateway
// without `roomPolicies`), so the rooms of a booted daemon silently had no
// prompts. `loadRoomPolicies` is the one shared path; this pins that both hosts
// call it, that it behaves, and that config's and the gateway's room shapes stay
// compatible (finding 12: compile-time assignability).

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChannelsPlatformConfig, EthosConfig, RawRoomEntry } from '@ethosagent/config';
import type { PlatformRoomPolicy, RoomEntry } from '@ethosagent/gateway';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import type { ModelRegistry } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { bootFileWith } from '../commands/__tests__/boot-sources';
import { loadRoomPolicies } from '../commands/gateway';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');

// Compile-time: each side must be assignable to the other. A field added to one
// shape and not the other fails `pnpm typecheck` here, not at runtime.
type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const _entryCompatible: Mutual<RawRoomEntry, RoomEntry> = true;
const _platformCompatible: Mutual<ChannelsPlatformConfig, PlatformRoomPolicy> = true;

describe('room policy: shapes', () => {
  it('config and gateway room shapes are mutually assignable (compile-time)', () => {
    expect([_entryCompatible, _platformCompatible]).toEqual([true, true]);
  });
});

describe('both production hosts pass roomPolicies', () => {
  it.each([
    ['ethos gateway start', 'apps/ethos/src/commands/gateway.ts'],
    ['ethos boot', 'apps/ethos/src/commands/boot.ts'],
  ])('%s builds its Gateway with the loadRoomPolicies table', async (_name, file) => {
    const src = file.endsWith('/boot.ts')
      ? bootFileWith('buildGateway({')
      : await readFile(join(ROOT, file), 'utf8');
    const call = src.slice(src.indexOf('  const gateway'));
    const start = call.indexOf('buildGateway({');
    const body = call.slice(start, call.indexOf('\n  });', start));
    expect(body).toMatch(/\n\s+roomPolicies(: await loadRoomPolicies\(storage, \w+\))?,/);
    if (!file.endsWith('/boot.ts'))
      expect(src).toMatch(/await loadRoomPolicies\(storage, config\)/);
  });
});

describe('loadRoomPolicies', () => {
  const registry: ModelRegistry = {
    entries: {
      sonnet: { alias: 'sonnet', provider: 'anthropic', modelId: 'claude-sonnet-5' },
    },
    default: 'sonnet',
    roles: {},
  };
  const entries = (e: Record<string, RawRoomEntry>): ChannelsPlatformConfig['entries'] =>
    Object.assign(Object.create(null), e);
  const config = (
    channels: Record<string, ChannelsPlatformConfig> | undefined,
    modelRegistry?: ModelRegistry,
  ): EthosConfig =>
    ({
      ...(channels ? { channels } : {}),
      ...(modelRegistry ? { modelRegistry } : {}),
    }) as unknown as EthosConfig;

  async function load(cfg: EthosConfig) {
    return loadRoomPolicies(new InMemoryStorage(), cfg);
  }

  it('no channels and no files: undefined, so no per-turn room work', async () => {
    expect((await load(config(undefined))).table).toBeUndefined();
  });

  it('with a registry: an alias and a role pass, an unknown alias is dropped with a warning', async () => {
    const { table, warnings } = await load(
      config(
        {
          slack: {
            entries: entries({
              C1: { model: 'sonnet' },
              C2: { model: 'deep' },
              C3: { model: 'nope', prompt: 'p' },
            }),
          },
        },
        registry,
      ),
    );
    expect(table?.slack?.entries.C1?.model).toBe('sonnet');
    expect(table?.slack?.entries.C2?.model).toBe('deep');
    expect(table?.slack?.entries.C3?.model).toBeUndefined();
    expect(warnings.join('\n')).toContain("'nope'");
  });

  it('with no registry: the value is a raw model id (core legacy path)', async () => {
    const { table, warnings } = await load(
      config({ slack: { entries: entries({ C1: { model: 'claude-haiku-4' } }) } }),
    );
    expect(table?.slack?.entries.C1?.model).toBe('claude-haiku-4');
    expect(warnings).toEqual([]);
  });
});
