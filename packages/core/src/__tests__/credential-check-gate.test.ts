import type { CompletionChunk, LLMProvider } from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentLoopConfig } from '../agent-loop';
import { AgentLoop } from '../agent-loop';
import { DefaultPersonalityRegistry } from '../defaults/noop-personality';
import { DefaultToolRegistry } from '../tool-registry';
import { createTestSafety } from './helpers/test-safety';

// ---------------------------------------------------------------------------
// openclaw-9.5 item 1 — the pre-turn credential check runs only for a run
// whose surface consumes `credential_required` (`RunOptions.credentialPrompt`).
// Every other consumer of the same loop (delegation, jobs, cron, MCP export)
// keeps today's behaviour: the turn runs and the plugin's own call fails.
// ---------------------------------------------------------------------------

function textLLM(calls: { n: number }): LLMProvider {
  return {
    name: 'scripted',
    model: 'mock-model',
    maxContextTokens: 200_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(): AsyncIterable<CompletionChunk> {
      calls.n += 1;
      yield { type: 'text_delta', text: 'answered' };
      yield { type: 'done', finishReason: 'end_turn' };
    },
    async countTokens() {
      return 1;
    },
  };
}

function buildLoop(check: NonNullable<AgentLoopConfig['credentialCheck']>, calls: { n: number }) {
  const registry = new DefaultPersonalityRegistry();
  registry.define({ id: 'ops', name: 'Ops', plugins: ['weather'] });
  registry.setDefault('ops');
  return new AgentLoop({
    llm: textLLM(calls),
    tools: new DefaultToolRegistry(),
    personalities: registry,
    safety: createTestSafety(),
    credentialCheck: check,
  });
}

async function drain(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const ev of gen) events.push(ev);
  return events;
}

const MISS = {
  pluginId: 'weather',
  credentialKey: 'API_KEY',
  kind: 'api_key' as const,
  label: 'Weather API key',
};

describe('credential check gate', () => {
  it('a run that consumes the event is refused pre-turn with the pending message', async () => {
    const calls = { n: 0 };
    const check = vi.fn(async () => MISS);
    const loop = buildLoop(check, calls);

    const events = await drain(
      loop.run('what is the weather', { sessionKey: 'k1', credentialPrompt: true }),
    );

    expect(check).toHaveBeenCalledWith('k1', 'what is the weather', {
      personalityId: 'ops',
      allowedPlugins: ['weather'],
    });
    expect(events.map((e) => e.type)).toContain('credential_required');
    const req = events.find((e) => e.type === 'credential_required');
    expect(req).toMatchObject({
      pluginId: 'weather',
      credentialKey: 'API_KEY',
      pendingUserMessage: 'what is the weather',
    });
    expect(events.at(-1)).toMatchObject({ type: 'done', text: '', turnCount: 0 });
    expect(calls.n).toBe(0);
  });

  it('a run that does not opt in never calls the check and runs the turn', async () => {
    const calls = { n: 0 };
    const check = vi.fn(async () => MISS);
    const loop = buildLoop(check, calls);

    const events = await drain(loop.run('what is the weather', { sessionKey: 'k2' }));

    expect(check).not.toHaveBeenCalled();
    expect(events.some((e) => e.type === 'credential_required')).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: 'done', text: 'answered' });
    expect(calls.n).toBe(1);
  });

  it('a null answer lets an opted-in run proceed', async () => {
    const calls = { n: 0 };
    const loop = buildLoop(async () => null, calls);

    const events = await drain(loop.run('hi', { sessionKey: 'k3', credentialPrompt: true }));

    expect(events.at(-1)).toMatchObject({ type: 'done', text: 'answered' });
    expect(calls.n).toBe(1);
  });
});
