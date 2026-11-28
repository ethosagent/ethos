// Extracted from compose-tools.ts (size gate); called only from `composeAllTools`.
import { privateChatSetFrom, turnWasShared } from '@ethosagent/core';
import { wrapUntrusted } from '@ethosagent/safety-injection';
import type {
  LLMProvider,
  MemoryContext,
  MemoryProvider,
  SecretsResolver,
} from '@ethosagent/types';
import type { InfrastructureResult } from './build-infrastructure';
import type { WiringConfig } from './index';
import type { WiringContext } from './types';
import type { WorldBuildBindings } from './worlds';

// ---------------------------------------------------------------------------
// World first build (plan world-model 5.3): what `world_build` reads and which model it calls.
//   - memory: the configured backend's provider, scope `personality:<id>` (MEMORY.md, USER.md);
//   - sessions: the personality's own sessions from the shared SessionStore; whether a session
//     was the owner's is `turnWasShared` (the one helper memory capture uses);
//   - llm: the main provider, metered as `tool_llm` (`usageMeter.meter`), resolved on first use;
//     compose-tools.ts builds it with `buildVerifierProviderGetter` and passes it in.
// The calling turn's fs reach is NOT here: `readFolder` arrives with each `port.build` call.
// ---------------------------------------------------------------------------

/** Newest messages read per session, and sessions listed per build. */
const WORLD_BUILD_MESSAGES = 300;
const WORLD_BUILD_SESSIONS = 500;

export function worldBuildBindings(
  config: WiringConfig,
  infra: InfrastructureResult,
  wiringCtx: WiringContext,
  secrets: SecretsResolver,
  llm: () => Promise<LLMProvider>,
): WorldBuildBindings {
  const { dataDir, log } = wiringCtx;
  const store = infra.sessionCompose.sessionStore;
  const privateChats = privateChatSetFrom(config.privateChats);
  let memory: Promise<MemoryProvider> | undefined;
  const memoryProvider = (): Promise<MemoryProvider> => {
    if (!memory) {
      const name = config.memory ?? 'markdown';
      const factory = infra.memoryProviders.get(name);
      if (!factory) throw new Error(`memory backend "${name}" is not registered (world build)`);
      memory = Promise.resolve(factory({ config: {}, dataDir, secrets, logger: log }));
    }
    return memory;
  };
  return {
    sources: {
      memory: async (pid) => {
        const provider = await memoryProvider();
        const ctx: MemoryContext = {
          scopeId: `personality:${pid}`,
          sessionId: 'world-build',
          sessionKey: 'world-build',
          platform: 'cli',
          workingDir: dataDir,
        };
        const [mem, user] = await Promise.all([
          provider.read('MEMORY.md', ctx),
          provider.read('USER.md', ctx),
        ]);
        return { memory: mem?.content ?? '', user: user?.content ?? '' };
      },
      async *sessions(pid, since) {
        const list = await store.listSessions({
          personalityId: pid,
          limit: WORLD_BUILD_SESSIONS,
          ...(since !== null ? { since: new Date(since) } : {}),
        });
        for (const session of list) {
          yield {
            session,
            messages: await store.getMessages(session.id, { limit: WORLD_BUILD_MESSAGES }),
          };
        }
      },
      isShared: (session) => turnWasShared(session, privateChats),
    },
    llm,
    model: config.model,
    wrapUntrusted,
  };
}
