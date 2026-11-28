// R9 (Task 4.1): the chat-only initiative tools never reach a run. Lives in wiring because a
// tools package cannot import `buildReadOnlyRegistry`. The shared-audience refusal half is
// extensions/tools-initiatives/src/__tests__/initiative-define-scope.test.ts.

import { INITIATIVE_CHAT_TOOLS } from '@ethosagent/initiative-runner';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import { createInitiativeChatTools } from '@ethosagent/tools-initiatives';
import type { InitiativeLedgerPort, MemoryProvider, SessionStore } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import {
  buildReadOnlyRegistry,
  defaultInitiativeToolFactories,
  type InitiativeToolFactories,
} from '../initiatives';

const ledger = {} as InitiativeLedgerPort;
const chat = createInitiativeChatTools({
  config: { save: async () => ({ ok: false, error: 'unused' }) },
  ideas: () => ledger,
  recall: { list: () => [] },
});

describe('R9 chat tools never reach a run', () => {
  it('R9 chat only, private only: absent from buildReadOnlyRegistry', () => {
    const base = defaultInitiativeToolFactories({
      env: {},
      toolsConfig: () => undefined,
      memory: {} as MemoryProvider,
      session: {} as SessionStore,
    });
    // Even a factory that hands the chat tools to the run registry cannot register them.
    const leaky: InitiativeToolFactories = {
      ...base,
      ledger: (port, id) => [...base.ledger(port, id), ...chat],
    };
    const registry = buildReadOnlyRegistry({
      personality: { id: 'open', name: 'open' },
      ledger,
      initiativeId: 'i1',
      sourcePaths: [],
      factories: leaky,
      storage: new InMemoryStorage(),
      dataDir: '/ethos-state',
    });
    const names = registry.getAvailable().map((t) => t.name);
    for (const name of INITIATIVE_CHAT_TOOLS) expect(names).not.toContain(name);
    expect(chat.map((t) => t.name).sort()).toEqual([...INITIATIVE_CHAT_TOOLS].sort());
  });
});
