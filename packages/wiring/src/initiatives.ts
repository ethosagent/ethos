import type { ToolSettingsMap } from '@ethosagent/config';
import { clampInitiativeBudgets, loadConstitution } from '@ethosagent/constitution';
import { DefaultToolRegistry } from '@ethosagent/core';
import {
  assertReadOnlyCapabilities,
  checkSources,
  createInitiativeRunner,
  effectiveEnabled,
  InitiativeConfigService,
  type InitiativeRunner,
  loadInitiativeSettings,
  parseInitiativeFile,
  readOnlyCapabilityBackends,
  repoSourcePaths,
  runToolNames,
  SELF_START_POOL_USD_DEFAULT,
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
import { composeReadTools as composeWorldReadTools } from '@ethosagent/tools-world/compose';
import { createXSearchTool } from '@ethosagent/tools-x-search';
import {
  type AgentSafety,
  type Constitution,
  type DecisionRow,
  EthosError,
  type GoalStore,
  type InitiativeLedgerPort,
  type InitiativeRecallPort,
  type InitiativeStore,
  type LLMProvider,
  type MemoryProvider,
  type PersonalityConfig,
  type PersonalityRegistry,
  type QuestionRow,
  SecretNotFoundError,
  type SecretRef,
  type SecretsResolver,
  type SessionStore,
  type Storage,
  type Tool,
  type WindowRow,
} from '@ethosagent/types';
import type { WorldToolPort } from '@ethosagent/world-service';

/**
 * The constructors an initiative run draws its tools from. Injectable so a test
 * can hand in a bad factory (`'L3 runs on build'`). `read` constructors may
 * return tools the run is not allowed (the file factory also returns
 * `write_file`); `buildReadOnlyRegistry` registers only `runToolNames(toolset)`.
 */
export interface InitiativeToolFactories {
  read: ReadonlyArray<() => Tool[]>;
  ledger: (port: InitiativeLedgerPort, initiativeId: string, explorationId?: string) => Tool[];
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
  /** Present only when `world.enabled`; absent means a run gets no world tool. */
  worldPort?: WorldToolPort;
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
  const { teamMemory, kanbanStore, goalStore, worldPort } = deps;
  if (teamMemory) read.push(() => createTeamMemoryTools(teamMemory));
  if (kanbanStore) read.push(() => createKanbanTools({ store: kanbanStore }));
  if (goalStore) read.push(() => createGoalTools(goalStore));
  if (worldPort) read.push(() => composeWorldReadTools({ port: worldPort }));
  return {
    read,
    ledger: (port, initiativeId, explorationId) => [
      ...createInitiativeLedgerTools(port, initiativeId, explorationId),
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
  /** The exploration an exploration window works on; the run's note and brief tools write only to it. */
  explorationId?: string;
  /** From the validated YAML; the `fs_reach.read` roots for read_file / search_files. */
  sourcePaths: readonly string[];
  factories: InitiativeToolFactories;
  /** Backs each read tool's `scopedFs` (readOnlyCapabilityBackends); reach is `sourcePaths` only. */
  storage: Storage;
  /**
   * How a ref resolves; absent means no tool resolves a secret. The refs allowed are NOT passed in:
   * they are the union of `capabilities.secrets` of the tools this run registers, so a ref no run
   * read tool declares is refused (`ScopedSecretsImpl`, pinned by `initiative-secrets.test.ts`).
   */
  secretsBackend?: (ref: SecretRef) => Promise<string>;
  /** The Ethos state dir; derives the read deny floor and state-dir exclusion, as build-infrastructure does. */
  dataDir: string;
}): DefaultToolRegistry {
  const allowed = new Set(runToolNames(input.personality.toolset));
  const run = [
    ...input.factories.read.flatMap((make) => make()),
    ...input.factories.ledger(input.ledger, input.initiativeId, input.explorationId),
    ...(input.recall ? input.factories.recall(input.recall, input.personality.id) : []),
  ].filter((tool) => allowed.has(tool.name));
  // Limitation (L3 / secrets, pinned only for what is below): `allowedRefs` is whatever the
  // registered read tools DECLARE in `capabilities.secrets`. Any exact ref a read tool declares is
  // allowed to it, and a glob declared as `prefix/*` matches by prefix only (ScopedSecretsImpl,
  // packages/core scoped-secrets.ts). Nothing checks that a tool uses a ref only for its own
  // provider; a read tool that declared a broad ref would hold it. initiative-secrets.test.ts
  // pins that an undeclared ref is refused, not that a declared one is used appropriately.
  const allowedRefs = [...new Set(run.flatMap((tool) => tool.capabilities.secrets ?? []))];
  const registry = new DefaultToolRegistry(
    readOnlyCapabilityBackends({
      storage: input.storage,
      sourcePaths: input.sourcePaths,
      ...(input.secretsBackend ? { secrets: { allowedRefs, backend: input.secretsBackend } } : {}),
      alwaysDenyPaths: defaultAlwaysDeny([input.dataDir]),
      stateDirs: [input.dataDir],
    }),
  );
  for (const tool of run) registry.register(withSourceReach(tool, input.sourcePaths));
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
 * Limitations (written down, not enforced): `reload` is called by the scheduled tick
 * (`createInitiativeRuntime`, every 5 minutes), so a settings toggle shows in chat within one
 * tick; the Phase 6 web-api `InitiativesService` adds an immediate call. `isEnabled` is synchronous and storage is not,
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
  /** An initiative's windows, oldest first; the scheduled tick reads them to see what already ran. */
  windows(initiativeId: string): WindowRow[];
  /** An initiative's clarify questions, oldest first; the owner digest lists the unanswered ones. */
  questions(initiativeId: string): QuestionRow[];
  /** Decisions on a personality's initiatives since an ISO time; the digest tells owner-approved from automatic starts. */
  decisionsSince(personalityId: string, sinceIso: string): DecisionRow[];
  /**
   * The daily cap `budget(...).capUsd` reports, per initiative: the YAML's `usd_per_day` clamped
   * by settings and the constitution. Set by the run loader on every load (so a lowered limit
   * applies at the next window). An initiative never loaded in this process reports 0, which a
   * run treats as no money (fail closed). No effect when the caller injected its own `capFor`.
   */
  setCap(initiativeId: string, usdPerDay: number): void;
  /** Binds `usd_per_exploration` (clamped) the same way; a proposal's budget never exceeds it. Unbound = 0. */
  setExplorationCap(initiativeId: string, usdPerExploration: number): void;
  /** Stores a run's read tools may use besides the ledger; compose fills them when the host has them. */
  readSources: {
    kanbanStore?: KanbanStore;
    teamMemory?: MemoryProvider;
    worldPort?: WorldToolPort;
  };
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
  const caps = new Map<string, number>();
  const capFor = deps.capFor ?? ((id: string) => caps.get(id) ?? 0);
  const explorationCaps = new Map<string, number>();
  let opened: SQLiteInitiativeStore | undefined;
  const open = (): SQLiteInitiativeStore => {
    opened ??= new SQLiteInitiativeStore(path, {
      capFor,
      explorationCapFor: (id) => explorationCaps.get(id) ?? 0,
    });
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
    reserveAndOpenWindow: (w) => open().reserveAndOpenWindow(w),
    touchReservation: (id, ttlMs) => open().touchReservation(id, ttlMs),
    extendExploration: (id, e) => open().extendExploration(id, e),
    drafts: (status) => open().drafts(status),
    settleDraft: (id, status, refusal) => open().settleDraft(id, status, refusal),
    reactionClock: (id) => open().reactionClock(id),
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
    windows: (id) => open().windows(id),
    questions: (id) => open().questions(id),
    decisionsSince: (pid, since) => open().decisionsSince(pid, since),
    setCap: (id, usd) => void caps.set(id, usd),
    setExplorationCap: (id, usd) => void explorationCaps.set(id, usd),
    readSources: {},
    close: () => opened?.close(),
  };
}

/**
 * The manual run surface (plan Task 5.1): one survey or one window now, through the same
 * read-only parts the L9 e2e test assembles. `createInitiativeRuntime`
 * (initiative-runtime.ts) drives it on a schedule; the runner holds no handle, so it needs no dispose.
 *
 * The YAML is re-read and re-validated at run time (O-4: a hand edit may have broken it) and its
 * `repo` sources are re-checked against `readableRoots`, so a constitution that narrowed them
 * since the save applies to the next run.
 *
 * Secrets: the host's resolver backs the registry, but only for refs the run's read tools
 * declare (`buildReadOnlyRegistry`). Limitation: no env-variable fallback beyond what the host's
 * resolver already merges.
 *
 * The daily cap has one source: the loader clamps `usd_per_day` (settings, constitution, and for
 * agent-origin the self-start pool), hands it to `ledger.setCap`, and the runner reads
 * `store.budget().capUsd`.
 */
export function createInitiativeRunnerFor(deps: {
  storage: Storage;
  dataDir: string;
  /** The compose-time ledger: its store, its cap binding and the stores read tools may use. */
  ledger: LazyInitiativeStore;
  personalities: PersonalityRegistry;
  llm: LLMProvider;
  safety: AgentSafety;
  /** Read-tool construction inputs: the loop's own search config and secrets, memory, session and goals. */
  config: Pick<InitiativeToolDeps, 'webSearchBackend' | 'searxngUrl' | 'toolSettings'> & {
    secretsResolver?: SecretsResolver;
  };
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
  const store = deps.ledger.store;
  const { kanbanStore, teamMemory, worldPort } = deps.ledger.readSources;
  const resolver = deps.config.secretsResolver;
  const secretsBackend = resolver
    ? async (ref: SecretRef): Promise<string> => {
        const value = await resolver.get(ref);
        if (value === null) throw new SecretNotFoundError(ref);
        return value;
      }
    : undefined;
  const factories =
    deps.factories ??
    defaultInitiativeToolFactories({
      env: process.env,
      toolsConfig: deps.toolsConfig,
      memory: deps.memory,
      session: deps.session,
      ...(deps.goalStore ? { goalStore: deps.goalStore } : {}),
      ...(kanbanStore ? { kanbanStore } : {}),
      ...(teamMemory ? { teamMemory } : {}),
      ...(worldPort ? { worldPort } : {}),
      ...(deps.config.webSearchBackend ? { webSearchBackend: deps.config.webSearchBackend } : {}),
      ...(deps.config.searxngUrl ? { searxngUrl: deps.config.searxngUrl } : {}),
      ...(deps.config.toolSettings ? { toolSettings: deps.config.toolSettings } : {}),
    });
  // The same class that saves a chat-made initiative saves an agent-made one: the runner calls
  // it with confirmedBy 'runner' and it refuses anything an owner would not be shown.
  const readSettings = async (id: string) =>
    (await loadInitiativeSettings(deps.storage, deps.dataDir, id)).settings;
  const readConstitution = () => readInitiativeConstitution(deps.storage, deps.dataDir);
  const config = new InitiativeConfigService({
    storage: deps.storage,
    dataDir: deps.dataDir,
    store,
    constitution: readConstitution,
    settings: readSettings,
    toolset: (id) => deps.personalities.get(id)?.toolset ?? [],
    schedule: () => {},
  });
  return createInitiativeRunner({
    store,
    selfStart: { store, config, settings: readSettings, constitution: readConstitution },
    llm: deps.llm,
    safety: deps.safety,
    personalities: deps.personalities,
    ...(deps.model ? { model: deps.model } : {}),
    ...(deps.clock ? { clock: deps.clock } : {}),
    onError: (err) =>
      deps.log?.warn(`initiative run failed: ${err instanceof Error ? err.message : String(err)}`),
    load: createInitiativeLoader(deps),
    buildRegistry: ({ initiativeId, personalityId, sourcePaths, explorationId }) => {
      const personality = deps.personalities.get(personalityId);
      if (!personality) throw new Error(`personality "${personalityId}" is not registered`);
      return buildReadOnlyRegistry({
        personality,
        ledger: store,
        recall: store,
        initiativeId,
        ...(explorationId ? { explorationId } : {}),
        sourcePaths,
        factories,
        storage: deps.storage,
        dataDir: deps.dataDir,
        ...(secretsBackend ? { secretsBackend } : {}),
      });
    },
  });
}

/**
 * Reads, validates and clamps one initiative for a run, and binds its daily cap on the ledger
 * (`ledger.setCap`). Shared by the runner and the scheduled tick (`createInitiativeRuntime`), so
 * both prime the same cap before anything asks the store for a budget.
 */
export function createInitiativeLoader(deps: {
  storage: Storage;
  dataDir: string;
  ledger: LazyInitiativeStore;
}): NonNullable<Parameters<typeof createInitiativeRunner>[0]['load']> {
  const store = deps.ledger.store;
  return async (id) => {
    const row = store.getInitiative(id);
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
    const settings = (await loadInitiativeSettings(deps.storage, deps.dataDir, row.personalityId))
      .settings;
    const { usdPerDay, usdPerExploration } = clampInitiativeBudgets(
      {
        settings: { dailyBudgetUsd: settings.dailyBudgetUsd },
        initiative: {
          usdPerDay: parsed.file.budget.usd_per_day,
          usdPerExploration: parsed.file.budget.usd_per_exploration,
        },
      },
      constitution.initiatives,
    );
    const pool = constitution.initiatives?.selfStartPoolUsdPerDay ?? SELF_START_POOL_USD_DEFAULT;
    const capUsd = parsed.file.origin === 'agent' ? Math.min(usdPerDay, pool) : usdPerDay;
    deps.ledger.setCap(id, capUsd);
    deps.ledger.setExplorationCap(id, usdPerExploration);
    return {
      personalityId: row.personalityId,
      file: { ...parsed.file, budget: { ...parsed.file.budget, usd_per_day: capUsd } },
      sourcePaths: repoSourcePaths(parsed.file.sources),
    };
  };
}
