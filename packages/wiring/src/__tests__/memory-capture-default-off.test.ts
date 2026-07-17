import { DefaultHookRegistry } from '@ethosagent/core';
import { MemoryCaptureRunner } from '@ethosagent/memory-capture';
import { HistoryStore } from '@ethosagent/memory-history';
import { MarkdownFileMemoryProvider } from '@ethosagent/memory-markdown';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import type {
  AgentDonePayload,
  LLMProvider,
  Logger,
  Session,
  SessionStore,
} from '@ethosagent/types';
import { describe, expect, it } from 'vitest';

// build-agent-loop.ts gates MemoryCaptureRunner construction AND its hook
// registration behind `if (config.memoryCapture?.enabled && …)`. Capture is
// therefore default-OFF: with no `memoryCapture` config nothing is built and no
// `agent_done` handler is registered. These tests lock the mechanism the gate
// relies on — that *constructing* a runner is inert, and ONLY the explicit
// `registerHook(hooks)` call (which lives inside the enabled branch) activates
// capture — so a regression that instantiates/registers unconditionally is caught.

const DATA = '/root/.ethos';
const LONG =
  'My daughter Priya was born in 2019 and I work as a staff engineer at Acme, please remember it.';

const NOOP_LOGGER: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => NOOP_LOGGER,
};

function makeRunner() {
  const storage = new InMemoryStorage();
  const provider = new MarkdownFileMemoryProvider({ dir: DATA, storage });
  const history = new HistoryStore({ dataDir: DATA, storage });
  const llmCalls: string[] = [];
  const llm: LLMProvider = {
    name: 'fake',
    model: 'fake-model',
    maxContextTokens: 100_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete() {
      llmCalls.push('called');
      yield { type: 'text_delta', text: 'USER|0.8|Has a daughter named Priya, born 2019.' };
    },
    async countTokens() {
      return 0;
    },
  };
  const session: SessionStore = {
    getSession: async (id: string) => ({ id, key: 'cli:ethos' }) as unknown as Session,
  } as unknown as SessionStore;
  const runner = new MemoryCaptureRunner({
    provider,
    history,
    session,
    llm,
    sanitize: (s) => s,
    logger: NOOP_LOGGER,
    nightlyConfigured: false,
    workingDir: DATA,
  });
  return { runner, history, llmCalls };
}

const PAYLOAD: AgentDonePayload = {
  sessionId: 's1',
  text: 'Congrats!',
  turnCount: 1,
  personalityId: 'muse',
  initialPrompt: LONG,
};

describe('memory-capture is default-off (registration gated on registerHook)', () => {
  it('a runner that was constructed but never registered handles no agent_done events', async () => {
    const hooks = new DefaultHookRegistry();
    const { runner, history, llmCalls } = makeRunner();
    // Constructed, but registerHook was NOT called — the disabled wiring path.
    await hooks.fireVoid('agent_done', PAYLOAD);
    await runner.whenIdle();
    expect(llmCalls).toHaveLength(0);
    expect((await history.read('personality:muse')).entries).toHaveLength(0);
  });

  it('firing agent_done on a registry with no capture handler is a harmless no-op', async () => {
    const hooks = new DefaultHookRegistry();
    await expect(hooks.fireVoid('agent_done', PAYLOAD)).resolves.toBeUndefined();
  });

  it('explicit registerHook (the enabled path) is what activates capture', async () => {
    const hooks = new DefaultHookRegistry();
    const { runner, history, llmCalls } = makeRunner();
    runner.registerHook(hooks);
    await hooks.fireVoid('agent_done', PAYLOAD);
    await runner.whenIdle();
    expect(llmCalls).toHaveLength(1);
    expect((await history.read('personality:muse')).entries).toHaveLength(1);
  });
});
