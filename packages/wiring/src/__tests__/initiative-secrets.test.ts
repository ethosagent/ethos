// plan initiative-engine 5.1 wiring gap: a run read tool resolves only the secret refs it
// declares (`buildReadOnlyRegistry` derives `allowedRefs` from the registered tools'
// `capabilities.secrets`), through the host's backend. An undeclared ref is refused.

import { InMemoryStorage } from '@ethosagent/storage-fs';
import type { InitiativeLedgerPort, PersonalityConfig, Tool, ToolContext } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { buildReadOnlyRegistry } from '../initiatives';

const personality: PersonalityConfig = { id: 'open', name: 'open', toolset: ['web_search'] };

function ctx(): ToolContext {
  return {
    sessionId: 's',
    sessionKey: 'initiative:i1:w',
    platform: 'cli',
    workingDir: '/tmp',
    currentTurn: 1,
    messageCount: 1,
    abortSignal: new AbortController().signal,
    emit: () => {},
    resultBudgetChars: 80_000,
  } as unknown as ToolContext;
}

/** A stand-in for the search tool: declares exa, tries to resolve whatever it is told to. */
const probe: Tool = {
  name: 'web_search',
  description: 'probe',
  schema: { type: 'object' },
  capabilities: { secrets: ['providers/exa/apiKey'] },
  execute: async (args, c) => {
    const ref = (args as { ref: string }).ref;
    try {
      return { ok: true, value: (await c.secretsResolver?.get(ref)) ?? 'none' };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        code: 'execution_failed',
      };
    }
  },
};

function build(withBackend: boolean) {
  return buildReadOnlyRegistry({
    personality,
    ledger: {} as InitiativeLedgerPort,
    initiativeId: 'i1',
    sourcePaths: [],
    storage: new InMemoryStorage(),
    dataDir: '/state',
    factories: { read: [() => [probe]], ledger: () => [], recall: () => [] },
    ...(withBackend ? { secretsBackend: async (ref: string) => `secret:${ref}` } : {}),
  });
}

async function resolve(registry: ReturnType<typeof build>, ref: string) {
  const [r] = await registry.executeParallel(
    [{ toolCallId: 'c', name: 'web_search', args: { ref } }],
    ctx(),
  );
  return r?.result;
}

describe('initiative run secrets', () => {
  it('a run read tool resolves its declared ref', async () => {
    expect(await resolve(build(true), 'providers/exa/apiKey')).toEqual({
      ok: true,
      value: 'secret:providers/exa/apiKey',
    });
  });

  it('an undeclared ref is refused', async () => {
    const res = await resolve(build(true), 'providers/anthropic/apiKey');
    expect(res?.ok).toBe(false);
  });

  it('without a host backend nothing resolves', async () => {
    const res = await resolve(build(false), 'providers/exa/apiKey');
    expect(res?.ok === true ? res.value : null).not.toBe('secret:providers/exa/apiKey');
  });
});
