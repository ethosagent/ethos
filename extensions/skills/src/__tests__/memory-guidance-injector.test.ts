// plan personality-memory-boundary G1-4 — the memory-guidance block tells the
// model to use `memory_read`/`memory_write`. A shared turn excludes those
// tools, so context assembly sets `isDm: false` and the guidance must vanish.

import type { PromptContext } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { MemoryGuidanceInjector } from '../memory-guidance-injector';

function ctx(isDm: boolean): PromptContext {
  return {
    sessionId: 's1',
    sessionKey: 'telegram:bot:-100',
    platform: 'telegram',
    model: 'test-model',
    history: [],
    isDm,
    turnNumber: 3,
  };
}

describe('MemoryGuidanceInjector and the turn audience', () => {
  it('emits nothing on a shared turn (isDm: false)', async () => {
    expect(await new MemoryGuidanceInjector().inject(ctx(false))).toBeNull();
  });

  it('emits the guidance on a private turn (isDm: true)', async () => {
    const result = await new MemoryGuidanceInjector().inject(ctx(true));
    expect(result?.content).toContain('memory_write');
  });
});
