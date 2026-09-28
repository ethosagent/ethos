// plan personality-memory-boundary G1-1/D4 — the team-memory-index injector
// lists `team:<name>` topics into the prompt. A group chat's members are not
// the team, so on a shared turn (`isDm: false`) it must make ZERO calls into
// the team memory provider, not merely render nothing.

import type { MemoryProvider, PromptContext } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { createTeamMemoryIndexInjector } from '../compose-tools';

function ctx(isDm: boolean): PromptContext {
  return {
    sessionId: 's1',
    sessionKey: 'sk1',
    platform: 'cli',
    model: 'test-model',
    history: [],
    isDm,
    turnNumber: 1,
  };
}

function spyTeamMemory(): MemoryProvider & { listCalls: number } {
  const spy = {
    listCalls: 0,
    async prefetch() {
      return null;
    },
    async read() {
      return null;
    },
    async search() {
      return [];
    },
    async sync() {},
    async list() {
      spy.listCalls++;
      return [{ key: 'architecture.md' }, { key: 'decisions.md' }];
    },
  };
  return spy;
}

describe('createTeamMemoryIndexInjector and the turn audience', () => {
  it('a shared turn gets no topic list and makes no team-memory call', async () => {
    const memory = spyTeamMemory();
    const result = await createTeamMemoryIndexInjector(memory, 'core').inject(ctx(false));
    expect(result).toBeNull();
    expect(memory.listCalls).toBe(0);
  });

  it('a private turn lists the topics', async () => {
    const memory = spyTeamMemory();
    const result = await createTeamMemoryIndexInjector(memory, 'core').inject(ctx(true));
    expect(memory.listCalls).toBe(1);
    expect(result?.content).toContain('- architecture');
    expect(result?.content).toContain('- decisions');
  });
});
