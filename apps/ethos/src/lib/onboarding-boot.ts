import type { AgentLoop } from '@ethosagent/core';
import type { SkillsInjector } from '@ethosagent/skills';
import type { McpManager } from '@ethosagent/tools-mcp';
import type { ExecutionBackendRegistry, NotificationRouter, ToolRegistry } from '@ethosagent/types';
import type { DangerPredicate } from '@ethosagent/web-api';
import type { LoopGoals } from './goal-slash';

/** What onboarding `ethos serve` hands over once `createAgentLoop` has built the loop. */
export interface BootedLoop {
  loop: AgentLoop;
  goals: LoopGoals;
  notificationRouter: NotificationRouter;
  toolRegistry?: ToolRegistry;
  /** Installed into the web API by the bind: MCP, Settings › Execution, renderers,
   *  and the per-turn personality reload. */
  mcpManager?: McpManager;
  executionBackends?: ExecutionBackendRegistry;
  skillsInjector?: SkillsInjector;
  refreshPersonalities?: () => Promise<void>;
  dispose: () => Promise<void>;
}

/** The consumers that receive the booted loop, in adoption order. */
export interface AdoptionSeams {
  /** The late-bound goal pair the web API was built around (lib/late-goals.ts). */
  goals: { bind(pair: LoopGoals): void; unbind(): void };
  /** `CreateWebApiResult.bindAgentLoop` — returns its own unbind. */
  web: {
    bindAgentLoop(
      loop: AgentLoop,
      extras: {
        notificationRouter: NotificationRouter;
        dangerPredicate: DangerPredicate;
        mcpManager?: McpManager;
        executionBackends?: ExecutionBackendRegistry;
        skillsInjector?: SkillsInjector;
        refreshPersonalities?: () => Promise<void>;
      },
    ): () => Promise<void>;
  };
  /** The deferred registry createWebApi registered its tools on (lib/deferred-tool-registry.ts). */
  tools: { setInner(registry: ToolRegistry): void };
  /** The approval danger check for this loop (`buildServeDangerPredicate`). */
  dangerPredicate: (loop: AgentLoop) => DangerPredicate;
}

/**
 * Hand a loop onboarding just booted to everything built around its absence:
 * the goal pair, the web API (stand-in + per-loop registrations) and the
 * deferred tool registry. All or nothing — when a step throws, every earlier
 * step is undone and the loop is disposed before the error propagates, so the
 * next boot starts from a clean slate (no "already wired", no goal pair bound
 * to a dead loop, no loop left running). Pinned by
 * lib/__tests__/onboarding-boot.test.ts.
 *
 * What this canNOT hand over in-process, and why — these need `ethos serve`
 * restarted, which the onboarding UI says and the boot logs repeat:
 *  - the cron scheduler, its trigger arming and the watcher manager: built by
 *    `runServe`'s configured branch AROUND the loop, not returned by
 *    `createAgentLoop`, and their boot sweep runs at startup;
 *  - the background job store, job runners and executor subscriptions: the
 *    Tasks surface and the run-digest/complete listeners attach to the executor
 *    instance that exists at construction;
 *  - the voice provider registries and sockets: constructed with their
 *    registries and attached to the HTTP server as it starts listening;
 *  - the plugin loader behind dashboards and the ACP/A2A/mesh surfaces, which
 *    their consumers hold by value and gate on presence.
 */
export async function adoptBootedLoop(booted: BootedLoop, seams: AdoptionSeams): Promise<void> {
  let unbindWeb: (() => Promise<void>) | undefined;
  let goalsBound = false;
  try {
    seams.goals.bind(booted.goals);
    goalsBound = true;
    unbindWeb = seams.web.bindAgentLoop(booted.loop, {
      notificationRouter: booted.notificationRouter,
      dangerPredicate: seams.dangerPredicate(booted.loop),
      ...(booted.mcpManager ? { mcpManager: booted.mcpManager } : {}),
      ...(booted.executionBackends ? { executionBackends: booted.executionBackends } : {}),
      ...(booted.skillsInjector ? { skillsInjector: booted.skillsInjector } : {}),
      ...(booted.refreshPersonalities ? { refreshPersonalities: booted.refreshPersonalities } : {}),
    });
    // Last: it flushes the web API's buffered tools into the loop's registry,
    // and a flush that throws leaves the buffer for the next boot.
    if (booted.toolRegistry) seams.tools.setInner(booted.toolRegistry);
  } catch (err) {
    await unbindWeb?.().catch(() => {});
    if (goalsBound) seams.goals.unbind();
    await booted.dispose().catch(() => {});
    throw err;
  }
}
