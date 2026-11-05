// Plan plugin-process-isolation §9.3 (crash half). A hosted plugin that dies,
// hangs or blows its heap fails ITS call and nothing else: the real AgentLoop
// still finishes the turn, and a sibling hosted plugin keeps answering.
// Pins: `HostCalls.callTool` / `PluginHost.handleExit` (host-calls.ts, host-entry.ts).

import type { InMemorySessionStore } from '@ethosagent/core';
import type { AgentEvent } from '@ethosagent/types';
import { afterEach, describe, expect, it } from 'vitest';
import {
  callTool,
  eventsOf,
  fixtureDir,
  type Harness,
  isAlive,
  makeHarness,
  SLOW,
  waitFor,
} from './helpers/harness';
import { runTurn, toolResults } from './helpers/loop';

let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

const turnCalling = (harness: Harness, tool: string) =>
  runTurn(harness, {
    pluginId: 'crashy',
    fixture: 'crashy',
    tool,
    finalText: 'recovered',
    sessionKey: 'cli:crash',
  });

async function expectTurnSurvived(
  turn: { events: AgentEvent[]; session: InMemorySessionStore },
  tool: string,
): Promise<void> {
  const { events, session } = turn;
  expect(events.find((e) => e.type === 'tool_end')).toMatchObject({ toolName: tool, ok: false });
  expect(events.some((e) => e.type === 'error')).toBe(false);
  expect(events.at(-1)?.type).toBe('done');
  expect(events.find((e) => e.type === 'done')).toMatchObject({ text: 'recovered' });
  // The persisted tool_result is HostCalls.toolFailure's crash text, not a not_available refusal.
  const results = await toolResults(session, 'cli:crash');
  expect(results).toHaveLength(1);
  expect(results[0]?.isError).toBe(true);
  expect(results[0]?.content).toContain("Plugin 'crashy'");
  expect(results[0]?.content).toContain(`while '${tool}' was running`);
  expect(results[0]?.content).toContain('may or may not have taken effect');
}

describe('a hosted tool that dies mid-call', () => {
  it(
    'process.exit mid-tool → execution_failed, the turn continues to done',
    async () => {
      h = await makeHarness();
      await expectTurnSurvived(await turnCalling(h, 'exit_now'), 'exit_now');
      const crashed = eventsOf(h, 'plugin_host.crashed');
      expect(crashed).toHaveLength(1);
      expect(crashed[0]?.payload).toMatchObject({ plugin_id: 'crashy', code: 3 });
    },
    SLOW,
  );

  it(
    'SIGKILL mid-tool → the same: execution_failed, the turn continues to done',
    async () => {
      h = await makeHarness();
      await expectTurnSurvived(await turnCalling(h, 'kill_self'), 'kill_self');
      expect(eventsOf(h, 'plugin_host.crashed')[0]?.payload).toMatchObject({
        plugin_id: 'crashy',
        signal: 'SIGKILL',
      });
    },
    SLOW,
  );

  it(
    'a tool call that crashes the host returns execution_failed through a lease',
    async () => {
      h = await makeHarness();
      const lease = await h.pool.acquire({ id: 'crashy', dir: fixtureDir('crashy') });
      const result = await callTool(lease, 'exit_now');
      expect(result).toMatchObject({ ok: false, code: 'execution_failed' });
    },
    SLOW,
  );
});

describe('a hosted tool that hangs or exhausts memory', () => {
  it(
    'an infinite loop, aborted → aborted result after the grace, then the host is killed',
    async () => {
      const harness = await makeHarness({
        cancelGraceMs: 200,
        pingIntervalMs: 2_000,
        pingTimeoutMs: 500,
      });
      h = harness;
      const lease = await harness.pool.acquire({ id: 'slow', dir: fixtureDir('slow') });
      const pid = harness.pool.pidOf('slow');
      const ac = new AbortController();
      const pending = callTool(lease, 'busy_loop', {}, ac.signal);
      setTimeout(() => ac.abort(), 50);
      const result = await pending;
      // The blocked event loop cannot read ethos/cancel: only the parent's grace timer resolves it.
      expect(result).toMatchObject({ ok: false, code: 'execution_failed' });
      expect(result.ok ? '' : result.error).toMatch(
        /^Aborted .*did not stop 'busy_loop' within 200 ms/,
      );
      // A host that never answers its ping is SIGKILLed.
      await waitFor(() => eventsOf(harness, 'plugin_host.crashed').length > 0, 15_000);
      expect(eventsOf(harness, 'plugin_host.crashed')[0]?.payload).toMatchObject({
        signal: 'SIGKILL',
      });
      await waitFor(() => !isAlive(pid), 5_000);
    },
    SLOW,
  );

  it(
    'a heap blow-up past max_heap_mb → crash path, the call fails and the parent lives',
    async () => {
      h = await makeHarness({ maxHeapMb: 160 });
      const lease = await h.pool.acquire({ id: 'crashy', dir: fixtureDir('crashy') });
      const pid = h.pool.pidOf('crashy');
      const result = await callTool(lease, 'heap_blow');
      expect(result).toMatchObject({ ok: false, code: 'execution_failed' });
      expect(eventsOf(h, 'plugin_host.crashed')).toHaveLength(1);
      expect(isAlive(pid)).toBe(false);
    },
    SLOW,
  );
});

describe('sibling isolation', () => {
  it(
    'a second hosted plugin is unaffected when the first one crashes',
    async () => {
      const harness = await makeHarness();
      h = harness;
      const [crashy, echo] = await Promise.all([
        harness.pool.acquire({ id: 'crashy', dir: fixtureDir('crashy') }),
        harness.pool.acquire({ id: 'echo', dir: fixtureDir('echo') }),
      ]);
      const echoPid = harness.pool.pidOf('echo');
      expect(echoPid).not.toBe(harness.pool.pidOf('crashy'));

      expect(await callTool(crashy, 'kill_self')).toMatchObject({ ok: false });
      await waitFor(() => eventsOf(harness, 'plugin_host.crashed').length > 0);

      expect(await callTool(echo, 'echo', { text: 'still here' })).toEqual({
        ok: true,
        value: 'still here',
      });
      expect(harness.pool.pidOf('echo')).toBe(echoPid);
      expect(isAlive(echoPid)).toBe(true);
      expect(
        eventsOf(harness, 'plugin_host.crashed').every((e) => e.payload.plugin_id === 'crashy'),
      ).toBe(true);
    },
    SLOW,
  );
});
