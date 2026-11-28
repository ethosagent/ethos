import type { DefaultToolRegistry } from '@ethosagent/core';
import {
  InitiativeConfigService,
  InitiativeIndexInjector,
  loadInitiativeSettings,
} from '@ethosagent/initiative-runner';
import type { KanbanStore } from '@ethosagent/kanban-store';
import {
  createChatInitiativeRecallTools,
  createInitiativeChatTools,
} from '@ethosagent/tools-initiatives';
import type { Logger, PersonalityRegistry, Storage } from '@ethosagent/types';
import type { DisposerStack } from './disposer-stack';
import {
  createInitiativeEnablement,
  createLazyInitiativeStore,
  type InitiativeEnablement,
  type LazyInitiativeStore,
  readInitiativeConstitution,
} from './initiatives';

/**
 * Initiative engine, chat side: the ledger opens lazily (`createLazyInitiativeStore`), so a
 * user who never uses the feature gets no `initiatives.db` and spends $0. YAML goes through
 * `InitiativeConfigService`, the only writer. Registers the chat tools; the caller pushes the
 * returned index injector after the skills injectors.
 */
export async function composeInitiativeChat(deps: {
  storage: Storage;
  dataDir: string;
  log: Logger;
  personalities: Pick<PersonalityRegistry, 'get' | 'list'>;
  tools: Pick<DefaultToolRegistry, 'register'>;
  disposers: DisposerStack;
  kanbanStore: KanbanStore | null;
}): Promise<{
  initiativeLedger: LazyInitiativeStore;
  initiativeEnablement: InitiativeEnablement;
  initiativeIndexInjector: InitiativeIndexInjector;
}> {
  const { storage, dataDir, log, personalities, tools, disposers, kanbanStore } = deps;
  const initiativeLedger = createLazyInitiativeStore({ storage, dataDir });
  if (kanbanStore) initiativeLedger.readSources.kanbanStore = kanbanStore;
  disposers.push('initiative ledger', () => initiativeLedger.close());
  const initiativeEnablement = await createInitiativeEnablement({
    storage,
    dataDir,
    personalityIds: () => personalities.list().map((p) => p.id),
    log,
  });
  const initiativeConfig = new InitiativeConfigService({
    storage,
    dataDir,
    store: initiativeLedger.store,
    constitution: () => readInitiativeConstitution(storage, dataDir),
    settings: async (id) => (await loadInitiativeSettings(storage, dataDir, id)).settings,
    toolset: (id) => personalities.get(id)?.toolset ?? [],
    // No runner yet: the schedule hook lands with the runner (plan Task 5.x).
    schedule: () => {},
  });
  for (const tool of createInitiativeChatTools({
    config: initiativeConfig,
    ideas: () => initiativeLedger.ledger,
    recall: initiativeLedger.recall,
  }))
    tools.register(tool);
  // initiative_list/search/get in chat: scoped by ctx.personalityId, hidden with the chat tools above.
  for (const tool of createChatInitiativeRecallTools(initiativeLedger.recall)) tools.register(tool);

  const initiativeIndexInjector = new InitiativeIndexInjector({
    store: initiativeLedger.store,
    ready: initiativeLedger.ready,
    isEnabled: initiativeEnablement.isEnabled,
    onError: (err) =>
      log.warn(`initiative index unavailable: ${err instanceof Error ? err.message : String(err)}`),
  });
  return { initiativeLedger, initiativeEnablement, initiativeIndexInjector };
}
