import { describe, expect, it } from 'vitest';
import { createThinkDeeperTool } from '../index';

function makeCtx() {
  return {
    sessionId: 's1',
    sessionKey: 'test:session',
    platform: 'cli',
    workingDir: '/tmp',
    currentTurn: 1,
    messageCount: 2,
    abortSignal: new AbortController().signal,
    emit: () => {},
    resultBudgetChars: 80_000,
  };
}
describe('think_deeper tool', () => {
  it('returns success with the reason in the value', async () => {
    const tool = createThinkDeeperTool();
    const ctx = makeCtx();
    const result = await tool.execute({ reason: 'complex refactor' }, ctx);
    expect(result.ok).toBe(true);
    expect(result.value).toContain('complex refactor');
  });
  it('has correct metadata', () => {
    const tool = createThinkDeeperTool();
    expect(tool.name).toBe('think_deeper');
    expect(tool.toolset).toBe('tier');
    expect(tool.schema.required).toContain('reason');
  });
});
