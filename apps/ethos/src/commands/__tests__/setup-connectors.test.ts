// Plan keyless-first-run §5.3 / D21: the CLI connectors step upserts the picked
// no-sign-in presets into mcp.json and attaches them to the born agent only;
// OAuth presets are printed as commands and never run.

import { join } from 'node:path';
import { createPersonalityRegistry } from '@ethosagent/personalities';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../wiring', async () => (await import('./setup-test-harness')).wiringMock());

import { noSignInPresets, oauthPresets } from '@ethosagent/wiring/keyless-probe';
import { firstTaskSuggestions, parsePicks, runConnectorsStep } from '../../lib/first-run';
import { duplicateBornPersonality } from '../personality-create';
import { afterEachHarness, beforeEachHarness, harness, scripted } from './setup-test-harness';

beforeEach(beforeEachHarness);
afterEach(afterEachHarness);

async function mcpServersOf(id: string): Promise<string[]> {
  const reg = await createPersonalityRegistry({
    storage: harness.storage,
    userPersonalitiesDir: harness.dataDir,
  });
  await reg.loadFromDirectory(join(harness.dataDir, 'personalities'));
  return reg.get(id)?.mcp_servers ?? [];
}

describe('setup connectors step', () => {
  it('picked presets are upserted and attached to the born agent only', async () => {
    await duplicateBornPersonality(harness.storage, harness.dataDir, 'researcher', 'sage');
    await duplicateBornPersonality(harness.storage, harness.dataDir, 'researcher', 'other');

    const presets = noSignInPresets();
    const deepwikiIdx = presets.findIndex((p) => p.name === 'deepwiki') + 1;
    expect(deepwikiIdx).toBeGreaterThan(0);
    const printed: string[] = [];
    const attached = await runConnectorsStep({
      storage: harness.storage,
      dataDir: harness.dataDir,
      agentId: 'sage',
      prompt: { ask: scripted([String(deepwikiIdx)]).ask, print: (l) => printed.push(l) },
    });

    expect(attached).toEqual(['deepwiki']);
    const mcp = JSON.parse((await harness.storage.read(join(harness.dataDir, 'mcp.json'))) ?? '{}');
    expect(JSON.stringify(mcp)).toContain('deepwiki');
    expect(await mcpServersOf('sage')).toEqual(['deepwiki']);
    expect(await mcpServersOf('other')).toEqual([]);
    // OAuth presets are shown as the two-line command, never connected here.
    const linear = oauthPresets().find((p) => p.name === 'linear');
    expect(printed).toContain(`  ethos mcp add linear --url ${linear?.url}`);
    expect(printed).toContain('  ethos personality mcp sage --attach linear');
    expect(JSON.stringify(mcp)).not.toContain('linear');
  });

  it('Enter skips: nothing written, nothing attached', async () => {
    await duplicateBornPersonality(harness.storage, harness.dataDir, 'researcher', 'sage');
    const attached = await runConnectorsStep({
      storage: harness.storage,
      dataDir: harness.dataDir,
      agentId: 'sage',
      prompt: { ask: scripted(['']).ask, print: () => {} },
    });
    expect(attached).toEqual([]);
    expect(await harness.storage.exists(join(harness.dataDir, 'mcp.json'))).toBe(false);
  });
});

describe('helpers', () => {
  it('parsePicks drops junk and out-of-range numbers', () => {
    expect(parsePicks('1, 3 x 99 0', 5)).toEqual([0, 2]);
  });

  it('first-task suggestions: at most four, chosen by what is connected', () => {
    expect(firstTaskSuggestions([])).toHaveLength(2);
    const some = firstTaskSuggestions(['deepwiki', 'linear']);
    expect(some.length).toBeLessThanOrEqual(4);
    expect(some.some((t) => /DeepWiki/.test(t))).toBe(true);
  });
});
