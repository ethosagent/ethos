import {
  AgentLoop,
  type AgentLoopConfig,
  type CapabilityBackends,
  DefaultHookRegistry,
  type DefaultToolRegistry,
  InMemorySessionStore,
  type RunOptions,
  ScopedSecretsImpl,
} from '@ethosagent/core';
import type { AgentSafety, LLMProvider, SecretRef, Storage } from '@ethosagent/types';
import { createInitiativeToolGate } from './tool-gate';

/**
 * L5. Everything a run's AgentLoop is built from. Nothing here reaches disk:
 * the session is in memory (no sessions.db rows), the hooks are fresh with only
 * the L4 gate, and no memory, storage, observability or injectors are passed.
 */
export interface ReadOnlyLoopParts {
  tools: DefaultToolRegistry;
  llm: LLMProvider;
  safety: AgentSafety;
  /** Fresh; only the L4 gate registered. */
  hooks: DefaultHookRegistry;
  session: InMemorySessionStore;
  /** No compaction watermark pages. */
  compaction: { autoCompact: false };
}

export function createReadOnlyLoopParts(input: {
  tools: DefaultToolRegistry;
  llm: LLMProvider;
  safety: AgentSafety;
  /** The L1 names for this run (`runToolNames(toolset)`). */
  allowed: ReadonlySet<string>;
}): ReadOnlyLoopParts {
  const hooks = new DefaultHookRegistry();
  hooks.registerModifying('before_tool_call', createInitiativeToolGate(input.allowed));
  return {
    tools: input.tools,
    llm: input.llm,
    safety: input.safety,
    hooks,
    session: new InMemorySessionStore(),
    compaction: { autoCompact: false },
  };
}

/**
 * The exact AgentLoop config for a run. Memory flush is opt-in in core
 * (`memoryConsolidation.enabled`) and is stated off here; it also needs `storage`
 * and `dataDir` for its state file, which are deliberately absent. Auto-compaction
 * is default-on in core (turn-end.ts), so `autoCompact: false` is load-bearing.
 */
export function readOnlyLoopConfig(parts: ReadOnlyLoopParts): AgentLoopConfig {
  return {
    llm: parts.llm,
    tools: parts.tools,
    session: parts.session,
    hooks: parts.hooks,
    safety: parts.safety,
    compaction: parts.compaction,
    memoryConsolidation: { enabled: false },
  };
}

export function createReadOnlyLoop(parts: ReadOnlyLoopParts): AgentLoop {
  return new AgentLoop(readOnlyLoopConfig(parts));
}

/** Every `AgentLoop.run` passes `roomAudience` (audience-census.test.ts); the caller drains it. */
export function readOnlyRunOptions(input: {
  initiativeId: string;
  windowId: string;
  abortSignal: AbortSignal;
  model?: string;
}): RunOptions {
  return {
    sessionKey: `initiative:${input.initiativeId}:${input.windowId}`,
    roomAudience: 'private',
    incognito: true,
    abortSignal: input.abortSignal,
    ...(input.model ? { modelOverride: input.model } : {}),
  };
}

/**
 * The backends the run's `DefaultToolRegistry` resolves each tool's ToolContext
 * from (core's `resolveCapabilities`, built from `tool.capabilities`). Pass the
 * result as `new DefaultToolRegistry(backends)`. No `kvStoreFactory` (no kvStore
 * ever), no `safeFetch` override, personality reach is the source paths for read
 * and empty for write (so a `from-personality` write reaches nothing), and
 * secrets resolve only for `secrets.allowedRefs`. A `scopedProcess` is only built
 * for a tool that declares `process`, which L3 refuses.
 */
export function readOnlyCapabilityBackends(input: {
  storage: Storage;
  sourcePaths: readonly string[];
  secrets?: {
    /** Exact refs or `prefix/*` globs; the search providers' refs the read tools declare. */
    allowedRefs: readonly SecretRef[];
    backend: (ref: SecretRef) => Promise<string>;
  };
  /** Required: a read scope must never run without the deny floor (`defaultAlwaysDeny`). */
  alwaysDenyPaths: string[];
  /** Required: the state dirs every `scopedFs` excludes (wiring's `dataDir`). */
  stateDirs: readonly string[];
}): CapabilityBackends {
  const secrets = input.secrets;
  const limited = secrets
    ? new ScopedSecretsImpl(new Set(secrets.allowedRefs), secrets.backend)
    : undefined;
  return {
    storage: input.storage,
    personalityFsReach: () => ({ read: [...input.sourcePaths], write: [] }),
    ...(limited ? { secretsBackend: (ref: SecretRef) => limited.get(ref) } : {}),
    alwaysDenyPaths: input.alwaysDenyPaths,
    stateDirs: input.stateDirs,
  };
}
