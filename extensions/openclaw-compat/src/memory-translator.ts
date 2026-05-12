import type {
  ContextInjector,
  InjectionResult,
  ListOpts,
  MemoryContext,
  MemoryEntry,
  MemoryEntryRef,
  MemoryProvider,
  MemorySnapshot,
  PromptContext,
  SearchOpts,
} from '@ethosagent/types';
import type {
  MemoryCorpusSupplement,
  MemoryPluginCapability,
  MemoryPluginRuntime,
  MemoryPromptSectionBuilder,
  OpenClawConfig,
} from './types';

// ---------------------------------------------------------------------------
// MemoryPluginCapability → EthosMemoryProvider
// ---------------------------------------------------------------------------

/**
 * Wraps an OpenClaw `MemoryPluginCapability` bundle (registered via
 * `api.registerMemoryCapability()`) as an Ethos `MemoryProvider`.
 *
 * Mapping decisions:
 * - `cap.promptBuilder` → `prefetch` returns the built string as memory content
 * - `cap.runtime` → delegates to `translateMemoryRuntime`
 * - `cap.flushPlanResolver` → dropped; Ethos handles flush timing internally
 * - `cap.publicArtifacts` → dropped; no Ethos equivalent
 * - `sync()` → no-op; OpenClaw flush is controlled by the host, not the plugin
 */
export function translateMemoryCapability(cap: MemoryPluginCapability): MemoryProvider {
  return {
    async prefetch(ctx: MemoryContext): Promise<MemorySnapshot | null> {
      if (cap.promptBuilder) {
        const lines = cap.promptBuilder({ availableTools: new Set() });
        if (lines.length === 0) return null;
        return { entries: [{ key: 'openclaw', content: lines.join('\n') }] };
      }
      if (cap.runtime) {
        return translateMemoryRuntime(cap.runtime).prefetch(ctx);
      }
      return null;
    },
    async read(_key: string, _ctx: MemoryContext): Promise<MemoryEntry | null> {
      return null;
    },
    async search(query: string, ctx: MemoryContext, opts?: SearchOpts): Promise<MemoryEntry[]> {
      if (cap.runtime) {
        return translateMemoryRuntime(cap.runtime).search(query, ctx, opts);
      }
      return [];
    },
    async sync(): Promise<void> {
      // OpenClaw memory flush is driven by flushPlanResolver (host-controlled).
      // No direct Ethos sync equivalent — updates are written by the plugin's
      // agent_end hook, not through this interface.
    },
    async list(_ctx: MemoryContext, _opts?: ListOpts): Promise<MemoryEntryRef[]> {
      return [];
    },
  };
}

// ---------------------------------------------------------------------------
// MemoryPluginRuntime → EthosMemoryProvider
// ---------------------------------------------------------------------------

/**
 * Wraps an OpenClaw `MemoryPluginRuntime` (registered via
 * `api.registerMemoryRuntime()`) as an Ethos `MemoryProvider`.
 *
 * `prefetch` calls `runtime.getMemorySearchManager()` and uses the manager's
 * `search()` method (U1 — duck-typed per plan/openclaw_api_surface.md).
 * If the manager doesn't expose `search()` or the context has no query,
 * returns null so the agent proceeds without memory context.
 */
export function translateMemoryRuntime(runtime: MemoryPluginRuntime): MemoryProvider {
  const searchImpl = async (
    query: string,
    ctx: MemoryContext,
    opts?: SearchOpts,
  ): Promise<MemoryEntry[]> => {
    const trimmed = query.trim();
    if (!trimmed) return [];
    const cfg = buildMinimalConfig(ctx);
    let manager: Awaited<ReturnType<MemoryPluginRuntime['getMemorySearchManager']>>['manager'];
    try {
      const result = await runtime.getMemorySearchManager({ cfg, agentId: ctx.sessionId });
      if (!result.manager) return [];
      manager = result.manager;
    } catch {
      return [];
    }
    if (!manager.search) return [];
    try {
      const results = await manager.search({ query: trimmed, maxResults: opts?.limit ?? 5 });
      return results.map((r) => ({ key: r.id ?? r.content.slice(0, 32), content: r.content }));
    } catch {
      return [];
    }
  };

  return {
    async prefetch(_ctx: MemoryContext): Promise<MemorySnapshot | null> {
      // Runtime-backed providers are query-driven; prefetch returns null
      // and AgentLoop relies on search() at recall time.
      return null;
    },
    async read(_key: string, _ctx: MemoryContext): Promise<MemoryEntry | null> {
      return null;
    },
    search: searchImpl,
    async sync(): Promise<void> {
      // Writes are handled by agent_end hooks inside the plugin, not here.
    },
    async list(_ctx: MemoryContext, _opts?: ListOpts): Promise<MemoryEntryRef[]> {
      return [];
    },
  };
}

// ---------------------------------------------------------------------------
// MemoryPromptSectionBuilder → ContextInjector
// ---------------------------------------------------------------------------

/**
 * Wraps an OpenClaw `MemoryPromptSectionBuilder` (registered via
 * `api.registerMemoryPromptSection()`) as an Ethos `ContextInjector`.
 *
 * The builder synchronously returns lines; the injector prepends them to the
 * system prompt. `priority` defaults to 90 (just below the skills injector).
 */
export function translatePromptSectionBuilder(
  pluginId: string,
  builder: MemoryPromptSectionBuilder,
  idx: number,
  priority = 90,
): ContextInjector {
  return {
    id: `openclaw-${pluginId}-prompt-section-${idx}`,
    priority,
    async inject(_ctx: PromptContext): Promise<InjectionResult | null> {
      const lines = builder({ availableTools: new Set() });
      if (lines.length === 0) return null;
      return { content: lines.join('\n'), position: 'prepend' };
    },
  };
}

// ---------------------------------------------------------------------------
// MemoryCorpusSupplement → ContextInjector
// ---------------------------------------------------------------------------

/**
 * Wraps an OpenClaw `MemoryCorpusSupplement` (registered via
 * `api.registerMemoryCorpusSupplement()`) as a search-based ContextInjector.
 *
 * Uses `ctx.query` from `PromptContext` (extended field) to run a search and
 * inject the top results. Falls back to null when no query is available.
 */
export function translateCorpusSupplement(
  pluginId: string,
  supplement: MemoryCorpusSupplement,
  idx: number,
): ContextInjector {
  return {
    id: `openclaw-${pluginId}-corpus-${idx}`,
    priority: 85,
    async inject(ctx: PromptContext): Promise<InjectionResult | null> {
      const query = (ctx as PromptContext & { query?: string }).query;
      if (!query) return null;
      try {
        const results = await supplement.search({ query, maxResults: 5 });
        if (results.length === 0) return null;
        const content = results.map((r) => r.content).join('\n\n---\n\n');
        return { content, position: 'prepend' };
      } catch {
        return null;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// before_prompt_build hook handler → ContextInjector
// ---------------------------------------------------------------------------

/**
 * Wraps an OpenClaw `before_prompt_build` hook handler as a ContextInjector.
 *
 * OpenClaw: `api.on('before_prompt_build', async (event, ctx) => ({ prependContext }))`
 * Ethos: `ContextInjector.inject(ctx) → InjectionResult`
 *
 * The handler receives a minimal event object matching what memory-lancedb-pro
 * passes to its recall injection path.
 */
export function translateBeforePromptBuildHook(
  pluginId: string,
  handler: (...args: unknown[]) => unknown,
  idx: number,
  priority = 90,
): ContextInjector {
  return {
    id: `openclaw-${pluginId}-before-prompt-build-${idx}`,
    priority,
    async inject(ctx: PromptContext): Promise<InjectionResult | null> {
      const event = { availableTools: new Set<string>() };
      const hookCtx = { sessionId: ctx.sessionId, platform: ctx.platform };
      let result: unknown;
      try {
        result = await handler(event, hookCtx);
      } catch {
        return null;
      }
      if (!result || typeof result !== 'object') return null;
      const r = result as Record<string, unknown>;
      if (typeof r.prependContext === 'string' && r.prependContext.length > 0) {
        return { content: r.prependContext, position: 'prepend' };
      }
      if (typeof r.appendContext === 'string' && r.appendContext.length > 0) {
        return { content: r.appendContext, position: 'append' };
      }
      return null;
    },
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function buildMinimalConfig(ctx: MemoryContext): OpenClawConfig {
  return {
    agentId: ctx.sessionId,
    platform: ctx.platform,
    sessionKey: ctx.sessionKey,
  };
}
