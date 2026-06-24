import type {
  AgentSafety,
  ContextEngineLLMHandle,
  ContextEngineRegistry,
  ContextInjector,
  HookRegistry,
  LLMProvider,
  McpPolicy,
  MemoryProvider,
  ModelTierName,
  PersonalityConfig,
  PersonalityObservabilityConfig,
  PersonalityRegistry,
  RequestDumpStore,
  SessionStore,
  Storage,
  ToolFilterOpts,
  ToolRegistry,
  WatcherDecision,
  WatcherEvent,
} from '@ethosagent/types';
import type { ClarifyBridge } from '../clarify/clarify-bridge';
import type { ContextStore } from '../context-store';
import type { AgentLoopObservability } from '../observability/agent-loop-observability';

// ---------------------------------------------------------------------------
// LoopDeps — dependency bag injected from AgentLoop's private fields
// ---------------------------------------------------------------------------

export interface LoopDeps {
  llm: LLMProvider;
  tools: ToolRegistry;
  personalities: PersonalityRegistry;
  memory: MemoryProvider;
  session: SessionStore;
  hooks: HookRegistry;
  safety: AgentSafety;
  injectors: ContextInjector[];
  injectorPluginIds: Map<ContextInjector, string>;
  maxIterations: number;
  historyLimit: number;
  platform: string;
  workingDir: string;
  resultBudgetChars: number;
  maxToolCallsPerTurn: number;
  maxIdenticalToolCalls: number;
  streamingTimeoutMs: number;
  modelRouting: Record<string, string>;
  memoryProviders: Map<
    string,
    (options?: Record<string, unknown>) => MemoryProvider | Promise<MemoryProvider>
  >;
  storage?: Storage;
  attachmentCache?: import('@ethosagent/types').AttachmentCache;
  dataDir?: string;
  observability?: AgentLoopObservability;
  contextEngines: ContextEngineRegistry;
  /** Context-engine LLM handle — preferred over engine-constructor injection. */
  llmHandle?: ContextEngineLLMHandle;
  clarifyBridge?: ClarifyBridge;
  requestDumpStore?: RequestDumpStore;
  teamId?: string;
  mcpPolicy?: McpPolicy;
  onToolMetric?: (opts: {
    pluginId: string;
    toolName: string;
    ok: boolean;
    durationMs: number;
    sessionId: string;
    turnId: string;
  }) => void;
  credentialCheck?: (
    sessionKey: string,
    pendingUserMessage: string,
  ) => Promise<{
    pluginId: string;
    credentialKey: string;
    kind: 'oauth' | 'api_key' | 'text';
    label: string;
    description?: string;
    authUrl?: string;
  } | null>;
  sessionCosts: Map<string, number>;
  sessionReadMtimes: Map<string, Map<string, { mtimeMs: number; readAtTurn: number }>>;
  contextStore: ContextStore;
}

// ---------------------------------------------------------------------------
// TurnSetup — products of the turn-setup stage
// ---------------------------------------------------------------------------

export interface TurnSetup {
  sessionId: string;
  sessionKey: string;
  personality: PersonalityConfig;
  obsConfig: PersonalityObservabilityConfig | undefined;
  traceId: string | undefined;
  turnNumber: number;
  lastCompactionTurn: number;
  activeTier: ModelTierName;
  effectiveModel: string;
  modelOverride: string | undefined;
  allowedTools: string[] | undefined;
  allowedPlugins: string[];
  filterOpts: ToolFilterOpts;
  memScopeId: string;
}

export type TurnSetupResult = { kind: 'refused' } | { kind: 'ready'; setup: TurnSetup };

// ---------------------------------------------------------------------------
// AssembledContext — products of the context-assembly stage
// ---------------------------------------------------------------------------

export interface AssembledContext {
  systemPrompt: string | undefined;
  llmMessages: import('@ethosagent/types').Message[];
  cacheBreakpoints: number[] | undefined;
  activeSkillFiles: string[] | undefined;
  injectionDefenseEnabled: boolean;
  baseMessageCount: number;
  userScopeId: string | undefined;
}

// ---------------------------------------------------------------------------
// WatcherTap — watcher observe/getHalt interface
// ---------------------------------------------------------------------------

export type HaltDecision = Extract<
  WatcherDecision,
  { action: 'pause' | 'force_approval' | 'terminate' }
>;

export interface WatcherTap {
  observe: (event: WatcherEvent) => void;
  getHalt: () => HaltDecision | null;
}

// ---------------------------------------------------------------------------
// resolveModelWithTier — extracted from AgentLoop private method
// ---------------------------------------------------------------------------

export function resolveModelWithTier(
  personality: PersonalityConfig,
  tier: ModelTierName,
  modelRouting: Record<string, string>,
  llmName: string,
  llmModel: string,
): { model: string; source: 'personality' | 'global' } {
  const personalityOverride = modelRouting[personality.id];
  if (personalityOverride) return { model: personalityOverride, source: 'personality' };

  // Only use tier config when the personality declares a provider that matches
  // the active LLM. This prevents Anthropic-specific model IDs from being
  // injected into OpenRouter/Ollama/Gemini providers. Without a matching
  // provider declaration, fall through to the global model.
  const modelConfig = personality.model;
  if (modelConfig && typeof modelConfig === 'object' && personality.provider === llmName) {
    const tierModel = modelConfig[tier] ?? modelConfig.default;
    if (tierModel) return { model: tierModel, source: 'personality' };
  }

  return { model: llmModel, source: 'global' };
}
