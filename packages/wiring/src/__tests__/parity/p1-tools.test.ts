// P1 — tool surface of the real composition root: EVERY registered tool as
// {name, toolset, description, schema, maxResultChars, available} sorted by name, then
// the tool names each built-in personality is offered (`toDefinitions(toolset)`). The
// registry's private map is read directly: `getAvailable()` filters on `isAvailable()`,
// so a tool gated on a credential or platform would vanish under the hermetic env and
// a lost gated tool would go unnoticed. Catches a tool lost, reworded or re-grouped.

import type { Tool } from '@ethosagent/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

/** The registry keeps `name -> { tool }` in a private map (same seam P2/P3 use). */
function registeredTools(registry: object): Tool[] {
  const map = Reflect.get(registry, 'tools');
  if (!(map instanceof Map)) throw new Error('ToolRegistry no longer keeps a private `tools` map');
  return [...map.values()].map((entry: { tool: Tool }) => entry.tool);
}

describe('P1 tool surface parity', () => {
  it('matches the tool fixture', () => {
    const { toolRegistry, personalities } = fx.runtime;
    const all = registeredTools(toolRegistry);
    const tools = all
      .map((t) => ({
        name: t.name,
        toolset: t.toolset ?? null,
        description: t.description,
        schema: t.schema,
        maxResultChars: t.maxResultChars ?? null,
        available: t.isAvailable ? t.isAvailable() : true,
      }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    const registered = new Set(all.map((t) => t.name));
    const byPersonality: Record<string, string[]> = {};
    for (const id of builtinPersonalityIds()) {
      const personality = personalities.get(id);
      if (!personality) throw new Error(`built-in personality not loaded: ${id}`);
      const names = toolRegistry
        .toDefinitions(personality.toolset)
        .map((d) => d.name)
        .sort();
      expect(
        names.filter((n) => !registered.has(n)),
        `${id} is offered tools that are not registered`,
      ).toEqual([]);
      byPersonality[id] = names;
    }
    assertParity('p1-tools', { tools, byPersonality });
  });
});
