import type { ToolSettingsMap } from '@ethosagent/config';
import { loadConstitution } from '@ethosagent/constitution';
import { DefaultToolRegistry } from '@ethosagent/core';
import {
  assertReadOnlyCapabilities,
  checkSources,
  createInitiativeRunner,
  effectiveEnabled,
  type InitiativeRunner,
  loadInitiativeSettings,
  parseInitiativeFile,
  readOnlyCapabilityBackends,
  repoSourcePaths,
  runToolNames,
} from '@ethosagent/initiative-runner';
import { initiativesDbPath, SQLiteInitiativeStore } from '@ethosagent/initiative-store';
import type { KanbanStore } from '@ethosagent/kanban-store';
import type { PersonalityCompose } from '@ethosagent/personalities/compose';
import { defaultAlwaysDeny, sensitiveDenyPaths } from '@ethosagent/storage-fs';
import { createEngineAskTool } from '@ethosagent/tools-answer-engines';
import { createFileTools } from '@ethosagent/tools-file';
import { createGoalTools } from '@ethosagent/tools-goals';
import {
  createInitiativeLedgerTools,
  createInitiativeRecallTools,
  createRunClarifyTool,
} from '@ethosagent/tools-initiatives';
import { createKanbanTools } from '@ethosagent/tools-kanban';
import { createMemoryTools, createTeamMemoryTools } from '@ethosagent/tools-memory';
import { createRedditSearchTool, createRedditThreadTool } from '@ethosagent/tools-reddit';
import {
  createLinkedInSearchTool,
  createQuoraSearchTool,
  createRedditWebSearchTool,
  createYouTubeCommentsTool,
  createYouTubeSearchTool,
} from '@ethosagent/tools-social-search';
import { createWebTools } from '@ethosagent/tools-web';
import { createXSearchTool } from '@ethosagent/tools-x-search';
import {
  type AgentSafety,
  type Constitution,
  EthosError,
  type GoalStore,
  type InitiativeLedgerPort,
  type InitiativeRecallPort,
  type InitiativeStore,
  type LLMProvider,
  type MemoryProvider,
  type PersonalityConfig,
  type PersonalityRegistry,
  type SecretRef,
  type SessionStore,
  type Storage,
  type Tool,
} from '@ethosagent/types';

/**
 * The constructors an initiative run draws its tools from. Injectable so a test
 * can hand in a bad factory (`'L3 runs on build'`). `read` constructors may
 * return tools the run is not allowed (the file factory also returns
 * `write_file`); `buildReadOnlyRegistry` registers only `runToolNames(toolset)`.
 */
export interface InitiativeToolFactories {
  read: ReadonlyArray<() => Tool[]>;
  ledger: (port: InitiativeLedgerPort, initiativeId: string) => Tool[];
  /** initiative_list/search/get over the read-only recall port, bound to the run's personality. */
  recall: (port: InitiativeRecallPort, personalityId: string) => Tool[];
}

/** Dependencies the default read constructors take; the same values compose-tools uses. */
export interface InitiativeToolDeps {
  env: Readonly<Record<string, string | undefined>>;
  toolsConfig: (
    personalityId: string,
  ) => ReturnType<PersonalityCompose['personalities']['getToolsConfig']>;
  webSearchBackend?: 'exa' | 'tavily' | 'brave';
  searxngUrl?: string;
  toolSettings?: ToolSettingsMap;
  /** `web_extract` summariser provider lookup, as `createWebTools` takes it. */
  resolveProvider?: NonNullable<Parameters<typeof createWebTools>[0]>['resolveProvider'];
  auxModel?: string;
  memory: MemoryProvider;
  session: SessionStore;
  teamMemory?: MemoryProvider;
  kanbanStore?: KanbanStore;
  goalStore?: GoalStore;
}

/** The default factories: the same constructors compose-tools.ts and build-agent-loop.ts call. */
export function defaultInitiativeToolFactories(deps: InitiativeToolDeps): InitiativeToolFactories {
  const spread = <K extends string, V>(key: K, value: V | undefined) =>
    value === undefined ? {} : ({ [key]: value } as Record<K, V>);
  const toolSettings = spread('toolSettings', deps.toolSettings);
  const siteSearchOptions = {
    resolvePersonalitySetting: (id: string) => deps.toolsConfig(id)?.web_search,
    ...spread('searchBackend', deps.webSearchBackend),
    ...spread('searxngUrl', deps.searxngUrl),
    ...toolSettings,
  };
  const youtubeOptions = {
    resolvePersonalitySetting: (id: string) => deps.toolsConfig(id)?.youtube,
    ...toolSettings,
  };
  const read: Array<() => Tool[]> = [
    () => createFileTools(),
    () => [
      ...createWebTools({
        ...spread('searchBackend', deps.webSearchBackend),
        ...spread('searxngUrl', deps.searxngUrl),
        resolvePersonalitySetting: (id) => deps.toolsConfig(id)?.web_search,
        ...toolSettings,
        ...spread('auxModel', deps.auxModel),
        ...spread('resolveProvider', deps.resolveProvider),
      }),
    ],
    () => [
      createXSearchTool({
        env: deps.env,
        resolvePersonalitySetting: (id) => deps.toolsConfig(id)?.x_search,
        ...toolSettings,
      }),
      createEngineAskTool({
        env: deps.env,
        resolvePersonalitySetting: (id) => deps.toolsConfig(id)?.engine_ask,
        ...toolSettings,
      }),
      createYouTubeSearchTool(youtubeOptions),
      createYouTubeCommentsTool(youtubeOptions),
      createQuoraSearchTool(siteSearchOptions),
      createLinkedInSearchTool(siteSearchOptions),
      createRedditWebSearchTool(siteSearchOptions),
      createRedditSearchTool(),
      createRedditThreadTool(),
    ],
    () => createMemoryTools(deps.memory, deps.session),
  ];
  const { teamMemory, kanbanStore, goalStore } = deps;
  if (teamMemory) read.push(() => createTeamMemoryTools(teamMemory));
  if (kanbanStore) read.push(() => createKanbanTools({ store: kanbanStore }));
  if (goalStore) read.push(() => createGoalTools(goalStore));
  return {
    read,
    ledger: (port, initiativeId) => [
      ...createInitiativeLedgerTools(port, initiativeId),
      createRunClarifyTool(port, initiativeId),
    ],
    recall: (port, personalityId) =>
      createInitiativeRecallTools(port, personalityId, { surface: 'run' }),
  };
}

/** `fs_reach.read` for tools that read from the personality's reach: the run's source paths instead. */
function withSourceReach(tool: Tool, sourcePaths: readonly string[]): Tool {
  if (tool.capabilities.fs_reach?.read === undefined) return tool;
  return {
    ...tool,
    capabilities: {
      ...tool.capabilities,
      fs_reach: { ...tool.capabilities.fs_reach, read: [...sourcePaths] },
    },
  };
}

/**
 * L2. A NEW DefaultToolRegistry, never derived from the chat registry: only names in
 * `runToolNames(personality.toolset)` are registered, so a chat-registry `alwaysInclude`
 * tool (`dashboard_save`, `get_skill`, `render_*`) cannot reach a run. Runs L3
 * (`assertReadOnlyCapabilities`) before returning; a failing tool throws
 * `INITIATIVE_TOOL_NOT_READ_ONLY` and the runner does not start.
 */
export function buildReadOnlyRegistry(input: {
  personality: PersonalityConfig;
  ledger: InitiativeLedgerPort;
  /** Read side of the store for initiative_list/search/get; absent means a run gets no recall tools. */
  recall?: InitiativeRecallPort;
  initiativeId: string;
  /** From the validated YAML; the `fs_reach.read` roots for read_file / search_files. */
  sourcePaths: readonly string[];
  factories: InitiativeToolFactories;
  /** Backs each read tool's `scopedFs` (readOnlyCapabilityBackends); reach is `sourcePaths` only. */
  storage: Storage;
  /** Refs the read tools may resolve, and how; absent means no tool resolves a secret. */
  secrets?: { allowedRefs: readonly SecretRef[]; backend: (ref: SecretRef) => Promise<string> };
  /** The Ethos state dir; derives the read deny floor and state-dir exclusion, as build-infrastructure does. */
  dataDir: string;
}): DefaultToolRegistry {
  const allowed = new Set(runToolNames(input.personality.toolset));
  const registry = new DefaultToolRegistry(
    readOnlyCapabilityBackends({
      storage: input.storage,
      sourcePaths: input.sourcePaths,
      ...(input.secrets ? { secrets: input.secrets } : {}),
      alwaysDenyPaths: defaultAlwaysDeny([input.dataDir]),
      stateDirs: [input.dataDir],
    }),
  );
  const candidates = [
    ...input.factories.read.flatMap((make) => make()),
    ...input.factories.ledger(input.ledger, input.initiativeId),
    ...(input.recall ? input.factories.recall(input.recall, input.personality.id) : []),
  ];
  for (const tool of candidates) {
    if (allowed.has(tool.name)) registry.register(withSourceReach(tool, input.sourcePaths));
  }
  assertReadOnlyCapabilities(registry.getAvailable(), (name) => ({
    pluginId: registry.getPluginId(name),
  }));
  return registry;
}

/**
 * The constitution as the initiative engine reads it. A malformed constitution means SAFE
 * MODE (build-infrastructure.ts), so the engine is switched off rather than guessed at.
 */
export async function readInitiativeConstitution(
  storage: Storage,
  dataDir: string,
): Promise<Constitution> {
  const load = await loadConstitution(storage, dataDir);
  return load.status === 'malformed' ? { initiatives: { enabled: false } } : load.constitution;
}

/**
 * Whether each personality takes initiatives: `effectiveEnabled(settings.yaml, constitution)`,
 * cached so `buildPersonalityToolExclude` (synchronous, called every turn) returns the same
 * answer on every turn. The cache changes only through `reload(id)`.
 *
 * Limitations (written down, not enforced): `reload` has no production caller until the
 * Phase 6 web-api `InitiativesService`, so until then a settings toggle applies at restart;
 * runs re-read settings each tick (Task 5.5). `isEnabled` is synchronous and storage is not,
 * so a personality absent from the cache (created after compose) cannot be resolved on its
 * first ask; it answers on (the settings default when no settings.yaml exists) until a
 * `reload(id)` reads its file. The kill switch is always honoured.
 */
export interface InitiativeEnablement {
  isEnabled(personalityId: string): boolean;
  /** Re-read one personality's settings.yaml and the constitution; no id re-reads every known personality. */
  reload(personalityId?: string): Promise<void>;
}

export async function createInitiativeEnablement(deps: {
  storage: Storage;
  dataDir: string;
  personalityIds: () => readonly string[];
  constitution?: () => Promise<Constitution>;
  /** Receives the reason a settings.yaml was invalid (that personality is paused). */
  log?: { warn(message: string): void };
}): Promise<InitiativeEnablement> {
  const readConstitution =
    deps.constitution ?? (() => readInitiativeConstitution(deps.storage, deps.dataDir));
  const enabled = new Map<string, boolean>();
  let killSwitch = false;
  const refresh = async (ids: readonly string[]): Promise<void> => {
    const constitution = await readConstitution();
    for (const id of ids) {
      const load = await loadInitiativeSettings(deps.storage, deps.dataDir, id);
      if (load.status === 'invalid') {
        deps.log?.warn(`initiatives paused for '${id}': invalid settings.yaml (${load.reason})`);
      }
      enabled.set(id, effectiveEnabled(load.settings, constitution));
    }
    killSwitch = constitution.initiatives?.enabled === false;
  };
  await refresh(deps.personalityIds());
  return {
    isEnabled: (id) => !killSwitch && (enabled.get(id) ?? true),
    reload: async (id) => {
      const known =
        id === undefined ? [...new Set([...enabled.keys(), ...deps.personalityIds()])] : [id];
      await refresh(known);
    },
  };
}

/** A ledger handle that opens `initiatives.db` on first use. */
export interface LazyInitiativeStore {
  /** Every call opens the db on first use; a user who never reaches one never gets the file. */
  store: InitiativeStore;
  /** Only the `InitiativeLedgerPort` methods, for tools; same lazy open. */
  ledger: InitiativeLedgerPort;
  /** Only list/search/get, for recall tools; same lazy open. */
  recall: InitiativeRecallPort;
  /** True when the ledger exists (already opened, or the file is on disk). Never creates it. */
  ready(): Promise<boolean>;
  /** A no-op until the db has been opened. */
  close(): void;
}

/**
 * `initiatives.db` is created by the first call through `store` (an initiative saved, an idea
 * added, a ledger read by a tool), never at compose time. Chat turns that only need the index
 * check `ready()` first, so a user who never uses the feature spends $0 and gets no file.
 * Pinned by `__tests__/initiative-lazy-store.test.ts`.
 */
export function createLazyInitiativeStore(deps: {
  storage: Storage;
  dataDir: string;
  capFor?: (initiativeId: string) => number;
}): LazyInitiativeStore {
  const path = initiativesDbPath(deps.dataDir);
  let opened: SQLiteInitiativeStore | undefined;
  const open = (): SQLiteInitiativeStore => {
    opened ??= new SQLiteInitiativeStore(path, deps.capFor ? { capFor: deps.capFor } : {});
    return opened;
  };
  const ledger: InitiativeLedgerPort = {
    addIdea: (i) => open().addIdea(i),
    propose: (p) => open().propose(p),
    proposeInitiativeDraft: (d) => open().proposeInitiativeDraft(d),
    addFinding: (f) => open().addFinding(f),
    submitBrief: (b) => open().submitBrief(b),
    addQuestion: (q) => open().addQuestion(q),
    ideas: (id) => open().ideas(id),
    budget: (id, day) => open().budget(id, day),
    ownerOf: (kind, id) => open().ownerOf(kind, id),
  };
  const recall: InitiativeRecallPort = {
    list: (f) => open().list(f),
    search: (pid, q, limit) => open().search(pid, q, limit),
    get: (id) => open().get(id),
  };
  const store: InitiativeStore = {
    ...ledger,
    ...recall,
    transitionInitiative: (id, to, why) => open().transitionInitiative(id, to, why),
    transitionExploration: (id, to, why) => open().transitionExploration(id, to, why),
    recordDecision: (d) => open().recordDecision(d),
    upsertInitiative: (row) => open().upsertInitiative(row),
    appendConfigVersion: (v) => open().appendConfigVersion(v),
    openWindow: (w) => open().openWindow(w),
    closeWindow: (id, r) => open().closeWindow(id, r),
    getInitiative: (id) => open().getInitiative(id),
    getExploration: (id) => open().getExploration(id),
    explorations: (id, states) => open().explorations(id, states),
    indexLines: (pid, max) => open().indexLines(pid, max),
  };
  return {
    store,
    ledger,
    recall,
    ready: async () => opened !== undefined || (await deps.storage.exists(path)),
    close: () => opened?.close(),
  };
}

/**
 * The manual run surface (plan Task 5.1): one survey or one window now, through the same
 * read-only parts the L9 e2e test assembles. 5.5 adds `createInitiativeRuntime` (`tick`,
 * `dispose`) on top of this; the runner holds no handle, so it needs no dispose of its own.
 *
 * The YAML is re-read and re-validated at run time (O-4: a hand edit may have broken it) and its
 * `repo` sources are re-checked against `readableRoots`, so a constitution that narrowed them
 * since the save applies to the next run.
 *
 * Limitation: no `secrets` are passed to the registry, so a read tool that needs a stored
 * credential (a search backend key) answers with its own "not configured" error in a run.
 */
export function createInitiativeRunnerFor(deps: {
  storage: Storage;
  dataDir: string;
  store: InitiativeStore;
  personalities: PersonalityRegistry;
  llm: LLMProvider;
  safety: AgentSafety;
  /** Read-tool construction inputs: the loop's own search config, memory, session and goals. */
  config: Pick<InitiativeToolDeps, 'webSearchBackend' | 'searxngUrl' | 'toolSettings'>;
  toolsConfig: InitiativeToolDeps['toolsConfig'];
  memory: MemoryProvider;
  session: SessionStore;
  goalStore?: GoalStore;
  /** Defaults to the real constructors; a test may hand in others. */
  factories?: InitiativeToolFactories;
  model?: string;
  clock?: () => Date;
  log?: { warn(message: string): void };
}): InitiativeRunner {
  const factories =
    deps.factories ??
    defaultInitiativeToolFactories({
      env: process.env,
      toolsConfig: deps.toolsConfig,
      memory: deps.memory,
      session: deps.session,
      ...(deps.goalStore ? { goalStore: deps.goalStore } : {}),
      ...(deps.config.webSearchBackend ? { webSearchBackend: deps.config.webSearchBackend } : {}),
      ...(deps.config.searxngUrl ? { searxngUrl: deps.config.searxngUrl } : {}),
      ...(deps.config.toolSettings ? { toolSettings: deps.config.toolSettings } : {}),
    });
  return createInitiativeRunner({
    store: deps.store,
    llm: deps.llm,
    safety: deps.safety,
    personalities: deps.personalities,
    ...(deps.model ? { model: deps.model } : {}),
    ...(deps.clock ? { clock: deps.clock } : {}),
    onError: (err) =>
      deps.log?.warn(`initiative run failed: ${err instanceof Error ? err.message : String(err)}`),
    load: async (id) => {
      const row = deps.store.getInitiative(id);
      if (!row) return null;
      const raw = await deps.storage.read(row.configPath);
      if (raw === null) return null;
      const parsed = parseInitiativeFile(raw);
      if (!parsed.ok) {
        throw new EthosError({
          code: 'CONFIG_INVALID',
          cause: `initiative "${id}" is invalid: ${parsed.error}`,
          action: 'Fix the file or ask the agent to redefine the initiative.',
        });
      }
      const constitution = await readInitiativeConstitution(deps.storage, deps.dataDir);
      const sources = checkSources(parsed.file.sources, {
        readableRoots: constitution.initiatives?.readableRoots ?? [],
        blocked: sensitiveDenyPaths([deps.dataDir]),
      });
      if (!sources.ok) {
        throw new EthosError({
          code: 'CONFIG_INVALID',
          cause: `initiative "${id}" cannot run: ${sources.error}`,
          action: 'Narrow the sources or widen readableRoots in Settings.',
        });
      }
      return {
        personalityId: row.personalityId,
        file: parsed.file,
        sourcePaths: repoSourcePaths(parsed.file.sources),
      };
    },
    buildRegistry: ({ initiativeId, personalityId, sourcePaths }) => {
      const personality = deps.personalities.get(personalityId);
      if (!personality) throw new Error(`personality "${personalityId}" is not registered`);
      return buildReadOnlyRegistry({
        personality,
        ledger: deps.store,
        recall: deps.store,
        initiativeId,
        sourcePaths,
        factories,
        storage: deps.storage,
        dataDir: deps.dataDir,
      });
    },
  });
}
