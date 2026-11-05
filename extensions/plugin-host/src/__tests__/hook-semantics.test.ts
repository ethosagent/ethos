// Plan plugin-process-isolation §9.3 (hook half). proxies.test.ts already pins
// overrideSystem dropped, FIFO void hooks, the void-queue bound and the
// allowedPlugins gate; this file pins what a hosted handler changes about the
// REAL registry (core's DefaultHookRegistry) around it: merge order, fail-open
// with later handlers still running, and a `before_tool_call` refusal.

import { DefaultHookRegistry, DefaultToolRegistry } from '@ethosagent/core';
import type { BeforePromptBuildPayload, BeforeToolCallPayload } from '@ethosagent/types';
import { afterEach, describe, expect, it } from 'vitest';
import { type Harness, makeHarness, SLOW } from './helpers/harness';
import { activateInto, runTurn, toolResults } from './helpers/loop';

let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

const promptPayload = {} as BeforePromptBuildPayload;
const toolPayload = {
  sessionId: 's',
  toolCallId: 'c',
  toolName: 'merge_probe',
  args: {},
} as BeforeToolCallPayload;

const regA = (hooks: DefaultHookRegistry): void => {
  hooks.registerModifying('before_prompt_build', async () => ({ appendSystem: 'A' }), {
    pluginId: 'a',
  });
  hooks.registerModifying('before_tool_call', async () => null, { pluginId: 'a' });
};

/** The merge fixture's handlers, in-process. */
const regB = (hooks: DefaultHookRegistry): void => {
  hooks.registerModifying(
    'before_prompt_build',
    async () => ({ appendSystem: 'B', prependSystem: 'B-pre' }),
    { pluginId: 'b' },
  );
  hooks.registerModifying('before_tool_call', async () => ({ args: { from: 'B' } }), {
    pluginId: 'b',
  });
};

const regC = (hooks: DefaultHookRegistry): void => {
  hooks.registerModifying(
    'before_prompt_build',
    async () => ({ appendSystem: 'C', prependSystem: 'C-pre', overrideSystem: 'C-over' }),
    { pluginId: 'c' },
  );
  hooks.registerModifying(
    'before_tool_call',
    async () => ({ args: { from: 'C' }, error: 'C-err' }),
    { pluginId: 'c' },
  );
};

describe('modifying merge order across the process boundary', () => {
  it(
    '[in-process A, hosted B, in-process C] merges exactly like all three in-process, key by key',
    async () => {
      h = await makeHarness();
      const allowed = ['a', 'b', 'c'];

      const ordered = new DefaultHookRegistry();
      regA(ordered);
      regB(ordered);
      regC(ordered);

      const mixed = new DefaultHookRegistry();
      regA(mixed);
      await activateInto(h, 'b', 'merge', new DefaultToolRegistry(), mixed);
      regC(mixed);

      const want = await ordered.fireModifying('before_prompt_build', promptPayload, allowed);
      const got = await mixed.fireModifying('before_prompt_build', promptPayload, allowed);
      // Pinned literally so a change to both sides at once is still caught.
      expect(want).toEqual({ appendSystem: 'A', prependSystem: 'B-pre', overrideSystem: 'C-over' });
      expect(got).toEqual(want);

      const wantTool = await ordered.fireModifying('before_tool_call', toolPayload, allowed);
      const gotTool = await mixed.fireModifying('before_tool_call', toolPayload, allowed);
      expect(wantTool).toEqual({ args: { from: 'B' }, error: 'C-err' });
      expect(gotTool).toEqual(wantTool);
    },
    SLOW,
  );
});

describe('a failing hosted handler never stops later handlers', () => {
  it(
    'a hosted timeout → null, and the in-process handlers registered after it still run',
    async () => {
      h = await makeHarness({ hookTimeoutMs: 300 });
      const hooks = new DefaultHookRegistry();
      await activateInto(h, 'hooks', 'hooks', new DefaultToolRegistry(), hooks);
      let laterRan = false;
      hooks.registerModifying(
        'message_sending',
        async () => {
          laterRan = true;
          return { content: 'from later handler' } as never;
        },
        { pluginId: 'later' },
      );
      const out = await hooks.fireModifying('message_sending', {} as never, ['hooks', 'later']);
      expect(laterRan).toBe(true);
      expect(out).toEqual({ content: 'from later handler' });
      expect(h.pool.entry('hooks')?.stats.timeouts).toBe(1);
    },
    SLOW,
  );

  it(
    'a hosted throw is swallowed (fail-open) and the in-process handlers registered after it still run',
    async () => {
      h = await makeHarness();
      const hooks = new DefaultHookRegistry();
      await activateInto(h, 'hooks', 'hooks', new DefaultToolRegistry(), hooks);
      // Positive control: the hosted handlers are registered and live.
      expect(await hooks.fireModifying('before_prompt_build', promptPayload, ['hooks'])).toEqual({
        appendSystem: 'A',
        prependSystem: 'P',
      });
      // The child's own fireModifying swallows the throw, so the parent sees {} (no handler output).
      expect(await hooks.fireModifying('before_tool_call', toolPayload, ['hooks'])).toEqual({});
      hooks.registerModifying('before_tool_call', async () => ({ error: 'later says no' }), {
        pluginId: 'later',
      });
      const out = await hooks.fireModifying('before_tool_call', toolPayload, ['hooks', 'later']);
      expect(out).toEqual({ error: 'later says no' });
    },
    SLOW,
  );
});

describe('before_tool_call error from a hosted plugin', () => {
  it(
    'refuses the call through the real loop: the tool never runs and an error tool_result is persisted',
    async () => {
      h = await makeHarness();
      let executed = 0;
      const { events, session } = await runTurn(h, {
        pluginId: 'gate',
        fixture: 'gate',
        tool: 'guarded',
        finalText: 'ok',
        sessionKey: 'cli:gate',
        extraTools: (tools) =>
          tools.register({
            name: 'guarded',
            description: 'must not run',
            schema: { type: 'object' },
            capabilities: {},
            async execute() {
              executed++;
              return { ok: true, value: 'ran' };
            },
          }),
      });

      expect(executed).toBe(0);
      expect(events.find((e) => e.type === 'tool_end')).toMatchObject({
        toolName: 'guarded',
        ok: false,
      });
      expect(events.at(-1)?.type).toBe('done');
      const results = await toolResults(session, 'cli:gate');
      expect(results).toHaveLength(1);
      expect(results[0]?.isError).toBe(true);
      expect(results[0]?.content).toContain('blocked by hosted gate');
    },
    SLOW,
  );
});
