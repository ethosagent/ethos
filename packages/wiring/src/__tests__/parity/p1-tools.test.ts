// P1 — tool surface of the real composition root: every registered tool as
// {name, toolset, description, schema, maxResultChars} sorted by name, then the tool
// names each built-in personality is offered (`toDefinitions(personality.toolset)`).
// Catches a tool lost, reworded or re-grouped in a dedup or a split.

import { afterAll, beforeAll, describe, it } from 'vitest';
import { assertParity } from './harness';
import {
  builtinPersonalityIds,
  createParityRuntime,
  type ParityHarnessRuntime,
} from './runtime-fixture';

let fx: ParityHarnessRuntime;
beforeAll(async () => {
  fx = await createParityRuntime();
}, 180_000);
afterAll(async () => {
  await fx?.close();
});

describe('P1 tool surface parity', () => {
  it('matches the tool fixture', () => {
    const { toolRegistry, personalities } = fx.runtime;
    const tools = toolRegistry
      .getAvailable()
      .map((t) => ({
        name: t.name,
        toolset: t.toolset ?? null,
        description: t.description,
        schema: t.schema,
        maxResultChars: t.maxResultChars ?? null,
      }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    const byPersonality: Record<string, string[]> = {};
    for (const id of builtinPersonalityIds()) {
      const personality = personalities.get(id);
      if (!personality) throw new Error(`built-in personality not loaded: ${id}`);
      byPersonality[id] = toolRegistry
        .toDefinitions(personality.toolset)
        .map((d) => d.name)
        .sort();
    }
    assertParity('p1-tools', { tools, byPersonality });
  });
});
