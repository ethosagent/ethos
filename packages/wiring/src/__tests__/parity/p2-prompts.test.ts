// P2 — the system prompt each built-in personality produces for one turn ("hi", empty
// memory), verbatim so a diff is readable. A scripted provider records what the loop
// would have sent. `prompt-prefix-stability.test.ts` already guarantees the text has
// no per-turn content. Catches injector order or wording drift.

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

describe('P2 system prompt parity', () => {
  it('matches the prompt fixture', async () => {
    const prompts: Record<string, string | null> = {};
    for (const id of builtinPersonalityIds()) {
      const before = fx.llm.calls.length;
      for await (const _event of fx.runtime.loop.run('hi', {
        personalityId: id,
        sessionKey: `cli:parity-${id}`,
      })) {
        // drain to exhaustion (CLAUDE.md: AgentLoop.run must be drained)
      }
      const call = fx.llm.calls[before];
      if (!call) throw new Error(`no LLM request captured for ${id}`);
      // The temp HOME is the only machine-specific text a prompt can carry.
      prompts[id] = call.options.system?.split(fx.env.home).join('<HOME>') ?? null;
    }
    assertParity('p2-prompts', prompts);
  }, 180_000);
});
