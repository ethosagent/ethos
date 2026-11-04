// Plan keyless-first-run §4.3 (D15): setup ends with a user-owned, born copy of
// the chosen built-in; a re-run reuses it; "keep" is an explicit branch that
// leaves the built-in default and skips connectors.

import { join } from 'node:path';
import { createPersonalityRegistry, hasBirthMarker } from '@ethosagent/personalities';
import { parseToolsetYaml } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../wiring', async () => (await import('./setup-test-harness')).wiringMock());

import { probeKeyless } from '@ethosagent/wiring/keyless-probe';
import { runReadlineFallback } from '../setup';
import {
  afterEachHarness,
  beforeEachHarness,
  fakeOllamaFetch,
  harness,
  scripted,
} from './setup-test-harness';

const probe = () =>
  probeKeyless({
    secrets: harness.secrets,
    platform: 'linux',
    totalMemBytes: 16 * 1024 ** 3,
    isRoot: false,
    fetchImpl: fakeOllamaFetch(['llama3.2']),
    home: harness.root,
  });

beforeEach(beforeEachHarness);
afterEach(afterEachHarness);

const setup = (
  answers: string[],
  existing = null as Parameters<typeof runReadlineFallback>[0]['existing'],
) =>
  runReadlineFallback({
    storage: harness.storage,
    existing,
    deps: { ask: scripted(answers).ask, probe, interactive: true },
  });

describe('setup — the born agent', () => {
  it('setup writes personality: <new id> and the copy carries a birth marker and propose_self_amendment', async () => {
    // keyless 1, personality default, name "Sage", no connectors, no task.
    const outcome = await setup(['1', '', 'Sage', '', '']);
    expect(outcome?.config.personality).toBe('sage');

    const { readFile } = await import('node:fs/promises');
    expect(await readFile(join(harness.dataDir, 'config.yaml'), 'utf-8')).toContain(
      'personality: sage',
    );
    expect(await hasBirthMarker(harness.storage, harness.dataDir, 'sage')).toBe(true);
    const toolset = parseToolsetYaml(
      (await harness.storage.read(
        join(harness.dataDir, 'personalities', 'sage', 'toolset.yaml'),
      )) ?? '',
    );
    expect(toolset).toContain('propose_self_amendment');
    // The built-in is untouched (not a user directory).
    expect(await harness.storage.exists(join(harness.dataDir, 'personalities', 'researcher'))).toBe(
      false,
    );
  });

  it('a re-run with the id taken reuses it, no second duplicate', async () => {
    await setup(['1', '', 'Sage', '', '']);
    const marker = join(harness.dataDir, 'personalities', 'sage', 'config.yaml');
    const before = await harness.storage.read(marker);

    // Same name again, but now the choice is the user-owned "sage" itself.
    const second = await setup(['1', 'sage', '', '', ''], null);
    expect(second?.config.personality).toBe('sage');
    expect(await harness.storage.read(marker)).toBe(before);
    const reg = await createPersonalityRegistry({
      storage: harness.storage,
      userPersonalitiesDir: harness.dataDir,
    });
    await reg.loadFromDirectory(join(harness.dataDir, 'personalities'));
    expect(reg.list().filter((p) => p.id.startsWith('sage'))).toHaveLength(1);
  });

  it('keep-built-in branch writes researcher and skips connectors', async () => {
    const io = scripted(['1', '', 'keep']);
    const outcome = await runReadlineFallback({
      storage: harness.storage,
      existing: null,
      deps: { ask: io.ask, probe, interactive: true },
    });
    expect(outcome?.config.personality).toBe('researcher');
    expect(
      await harness.storage.exists(join(harness.dataDir, 'personalities', 'my-researcher')),
    ).toBe(false);
    // Nothing about connectors or first tasks was asked after "keep".
    expect(io.asked.some((q) => /Numbers to connect|Number to start/.test(q))).toBe(false);
  });
});
