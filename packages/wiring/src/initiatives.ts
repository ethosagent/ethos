import type { ToolSettingsMap } from '@ethosagent/config';
import { DefaultToolRegistry } from '@ethosagent/core';
import {
  assertReadOnlyCapabilities,
  readOnlyCapabilityBackends,
  runToolNames,
} from '@ethosagent/initiative-runner';
import type { KanbanStore } from '@ethosagent/kanban-store';
import type { PersonalityCompose } from '@ethosagent/personalities/compose';
import { defaultAlwaysDeny } from '@ethosagent/storage-fs';
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
import type {
  GoalStore,
  InitiativeLedgerPort,
  InitiativeRecallPort,
  MemoryProvider,
  PersonalityConfig,
  SecretRef,
  SessionStore,
  Storage,
  Tool,
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
