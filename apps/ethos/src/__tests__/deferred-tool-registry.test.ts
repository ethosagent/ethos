import { DefaultToolRegistry } from '@ethosagent/core';
import type { Tool, ToolContext } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { DeferredToolRegistry } from '../lib/deferred-tool-registry';

const makeTool = (name: string, toolset?: string): Tool => ({
  name,
  description: `Test tool ${name}`,
  schema: { type: 'object' },
  ...(toolset ? { toolset } : {}),
  capabilities: {},
  execute: async () => ({ ok: true, value: name }),
});

const makeCtx = (): ToolContext => ({
  sessionId: 's1',
  sessionKey: 'cli:default',
  platform: 'cli',
  workingDir: '/tmp',
  currentTurn: 1,
  messageCount: 1,
  abortSignal: new AbortController().signal,
  emit: () => {},
  resultBudgetChars: 10_000,
});

describe('DeferredToolRegistry', () => {
  it('register before setInner does not throw and the tool is visible', () => {
    // Regression: the old onboarding stub had no register() at all, so
    // createWebApi's dashboard-tool registration crashed serve at boot.
    const reg = new DeferredToolRegistry();
    expect(() => reg.register(makeTool('dashboard_create'))).not.toThrow();
    expect(reg.getAvailable().map((t) => t.name)).toEqual(['dashboard_create']);
    expect(reg.get('dashboard_create')?.name).toBe('dashboard_create');
  });

  it('getForToolset filters buffered tools before setInner', () => {
    const reg = new DeferredToolRegistry();
    reg.register(makeTool('a', 'dashboard'));
    reg.register(makeTool('b', 'file'));
    expect(reg.getForToolset('dashboard').map((t) => t.name)).toEqual(['a']);
  });

  it('setInner flushes buffered registrations into the real registry in order', () => {
    const deferred = new DeferredToolRegistry();
    deferred.register(makeTool('first'));
    deferred.register(makeTool('second'));
    const real = new DefaultToolRegistry();
    deferred.setInner(real);
    expect(real.getAvailable().map((t) => t.name)).toEqual(['first', 'second']);
    // Later registrations delegate straight through.
    deferred.register(makeTool('third'));
    expect(real.get('third')?.name).toBe('third');
  });

  it('executeParallel before setInner returns SETUP_REQUIRED results without throwing', async () => {
    const reg = new DeferredToolRegistry();
    reg.register(makeTool('dashboard_create'));
    const results = await reg.executeParallel(
      [{ toolCallId: 'c1', name: 'dashboard_create', args: {} }],
      makeCtx(),
    );
    expect(results).toHaveLength(1);
    const result = results[0]?.result;
    expect(result?.ok).toBe(false);
    if (result && result.ok === false && result.code === 'not_available') {
      expect(result.reason).toBe('SETUP_REQUIRED');
      expect(result.error).toContain('Setup required');
    } else {
      expect.fail('expected a not_available result');
    }
  });

  it('executeParallel delegates after setInner', async () => {
    const deferred = new DeferredToolRegistry();
    deferred.register(makeTool('echo'));
    deferred.setInner(new DefaultToolRegistry());
    const results = await deferred.executeParallel(
      [{ toolCallId: 'c1', name: 'echo', args: {} }],
      makeCtx(),
    );
    expect(results[0]?.result).toEqual({ ok: true, value: 'echo' });
  });

  it('unregister drops a buffered tool before setInner', () => {
    const reg = new DeferredToolRegistry();
    reg.register(makeTool('gone'));
    reg.unregister('gone');
    expect(reg.getAvailable()).toEqual([]);
  });

  it('toDefinitions is empty before setInner and delegates after', () => {
    const deferred = new DeferredToolRegistry();
    deferred.register(makeTool('echo'));
    expect(deferred.toDefinitions()).toEqual([]);
    deferred.setInner(new DefaultToolRegistry());
    expect(deferred.toDefinitions().map((d) => d.name)).toEqual(['echo']);
  });
});
