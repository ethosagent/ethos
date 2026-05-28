// E3 — ImprovementFork: post-turn analysis fork.
//
// After every agent turn, register() fires an `agent_done` void hook.
// If the turn passes threshold + cooldown checks, run() spawns a
// lightweight AgentLoop with a restricted 4-tool toolset (memory_read,
// memory_write, skill_read, skill_propose) and a rubric system prompt.
// The fork classifies the turn as memory, skill, or nothing — then acts.
//
// The fork uses a fresh InMemorySessionStore so it never pollutes the
// parent's session. It does NOT call close() on shared providers.

import { join } from 'node:path';
import {
  AgentLoop,
  DefaultHookRegistry,
  DefaultToolRegistry,
  InMemorySessionStore,
} from '@ethosagent/core';
import type {
  AgentDonePayload,
  HookRegistry,
  LLMProvider,
  MemoryContext,
  MemoryProvider,
  PersonalityRegistry,
  SessionStore,
  Storage,
  Tool,
} from '@ethosagent/types';
import { buildForkContext } from './fork-context';
import { createSkillProposeTool, createSkillReadTool } from './tools';

export interface ImprovementRuntime {
  llm: LLMProvider;
  model: string;
  memoryProvider: MemoryProvider;
  /** Parent's session store — used to read turn messages for context. */
  sessionStore: SessionStore;
}

export interface ImprovementForkOptions {
  hooks: HookRegistry;
  runtime: ImprovementRuntime;
  personalities: PersonalityRegistry;
  dataDir: string;
  storage: Storage;
  now?: () => number;
  onSkillProposed?: (skillId: string, personalityId: string) => void;
}

// Rubric system prompt for the fork personality.
const RUBRIC_SYSTEM = `You are the self-improvement reviewer. After each user turn you receive a clean summary of what just happened. Your only job: classify and act.

Rules for classification:
- MEMORY: a fact about the user, their preferences, their project, or a constraint that should survive across sessions. Write it with memory_write immediately.
- SKILL: a generalizable approach the agent took that worked well and is reusable across future turns. Examples: a multi-step research pattern, a useful sequencing rule for tools, a heuristic that improved the answer. Propose it with skill_propose. Prefer updating an existing skill over creating a new one.
- NOTHING: a routine conversation, a one-off answer, a clarification. Do nothing.

Never write both memory and skill in the same turn. Pick the stronger signal.
Never invent facts or extrapolate beyond what the transcript shows.`;

interface CooldownState {
  lastFiredAtMs: number;
}

export class ImprovementFork {
  private readonly cooldowns = new Map<string, CooldownState>();
  private readonly opts: ImprovementForkOptions;
  private readonly now: () => number;

  constructor(opts: ImprovementForkOptions) {
    this.opts = opts;
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * Register an `agent_done` void hook. When shouldFork returns true,
   * spawns a background fork via run(). Returns the cleanup function.
   */
  register(): () => void {
    return this.opts.hooks.registerVoid('agent_done', async (payload: AgentDonePayload) => {
      if (this.shouldFork(payload)) {
        await this.run(payload);
      }
    });
  }

  private shouldFork(payload: AgentDonePayload): boolean {
    if (!payload.personalityId) return false;

    const personality = this.opts.personalities.get(payload.personalityId);
    if (!personality) return false;

    const cfg = personality.skill_evolution;
    if (!cfg?.enabled) return false;

    const minToolCalls = cfg.min_tool_calls ?? 5;
    const successfulCalls = payload.successfulToolCalls ?? 0;
    if (successfulCalls < minToolCalls) return false;

    // Cooldown — refuse to re-fire too quickly per personality.
    const cooldownMinutes = cfg.cooldown_minutes ?? 60;
    const state = this.cooldowns.get(personality.id);
    const nowMs = this.now();
    if (state && nowMs - state.lastFiredAtMs < cooldownMinutes * 60_000) return false;

    this.cooldowns.set(personality.id, { lastFiredAtMs: nowMs });
    return true;
  }

  private async run(payload: AgentDonePayload): Promise<void> {
    const personality = this.opts.personalities.get(payload.personalityId ?? '');
    if (!personality) return;

    // 1. Build fork context from the parent's session store.
    const context = await buildForkContext(payload, this.opts.runtime.sessionStore);

    // 2. Build the user prompt. Prepend the rubric (AgentLoop's RunOptions has
    //    no `system` field — injectors build the system prompt internally).
    const activeSkillHint = payload.activeSkillFiles?.length
      ? `\nActive skills for this turn: [${payload.activeSkillFiles.join(', ')}]\nPrefer updating one of these if the pattern fits.`
      : '';
    const userPrompt = `${RUBRIC_SYSTEM}\n\n${context}${activeSkillHint}`;

    // 3. Build the restricted fork tool registry.
    const pendingDir = join(this.opts.dataDir, 'skills', '.pending', personality.id);
    const skillsDirs = personality.skillsDirs ?? [];
    let proposed = false;

    const forkTools = new DefaultToolRegistry();

    // Skill tools (cast needed: Tool<T> is contravariant in T; register() takes Tool<unknown>)
    forkTools.register(createSkillReadTool({ storage: this.opts.storage, skillsDirs }) as Tool);
    forkTools.register(
      createSkillProposeTool({
        storage: this.opts.storage,
        pendingDir,
        now: this.opts.now,
        onProposed: () => {
          proposed = true;
        },
      }) as Tool,
    );

    // Memory tools — lightweight wrappers around the shared MemoryProvider.
    // These avoid pulling in the full @ethosagent/tools-memory package.
    const memCtx: MemoryContext = {
      scopeId: `personality:${personality.id}`,
      sessionId: 'improvement-fork',
      sessionKey: 'improvement-fork',
      platform: 'fork',
      workingDir: '',
    };
    const memProvider = this.opts.runtime.memoryProvider;

    forkTools.register(createMemoryReadTool(memProvider, memCtx));
    forkTools.register(createMemoryWriteTool(memProvider, memCtx) as Tool);

    // 4. Create the fork AgentLoop with restricted toolset.
    const forkSession = new InMemorySessionStore();
    const forkHooks = new DefaultHookRegistry(); // clean — prevents fork-to-fork recursion

    const forkLoop = new AgentLoop({
      llm: this.opts.runtime.llm,
      tools: forkTools,
      session: forkSession,
      hooks: forkHooks,
      memory: this.opts.runtime.memoryProvider,
    });

    // 5. Run the fork — single turn, drain all events.
    try {
      for await (const _event of forkLoop.run(userPrompt, {
        sessionKey: `improvement-fork-${Date.now()}`,
      })) {
        // drain — no streaming
      }
    } catch {
      // Fork failures are non-fatal.
    }

    // 6. If a skill was proposed, fire the callback.
    if (proposed && this.opts.onSkillProposed) {
      this.opts.onSkillProposed(`auto-${Date.now()}`, personality.id);
    }
  }
}

/** Reset cooldowns for testing. */
export function resetImprovementForkCooldowns(fork: ImprovementFork): void {
  // Access the private cooldowns map via bracket notation for test-only use.
  (fork as unknown as { cooldowns: Map<string, CooldownState> }).cooldowns.clear();
}

// ---------------------------------------------------------------------------
// Inline memory tools — minimal wrappers that avoid a tools-memory dep.
// ---------------------------------------------------------------------------

function createMemoryReadTool(provider: MemoryProvider, ctx: MemoryContext): Tool {
  return {
    name: 'memory_read',
    description: 'Read the current memory (MEMORY.md and USER.md).',
    toolset: 'memory',
    capabilities: {},
    schema: { type: 'object', properties: {}, required: [] },
    async execute() {
      const result = await provider.prefetch(ctx);
      if (!result) return { ok: true, value: '(No memory content found)' };
      const parts = result.entries.map((e) => `## ${e.key}\n${e.content}`).join('\n\n');
      return { ok: true, value: parts };
    },
  };
}

interface MemoryWriteArgs {
  store: string;
  action: string;
  content: string;
}

function createMemoryWriteTool(
  provider: MemoryProvider,
  ctx: MemoryContext,
): Tool<MemoryWriteArgs> {
  return {
    name: 'memory_write',
    description:
      'Write to memory. Specify store (memory or user), action (add/replace/remove), and content.',
    toolset: 'memory',
    capabilities: {},
    schema: {
      type: 'object',
      properties: {
        store: {
          type: 'string',
          enum: ['memory', 'user'],
          description: 'Which store to write to',
        },
        action: {
          type: 'string',
          enum: ['add', 'replace', 'remove'],
          description: 'Write action',
        },
        content: { type: 'string', description: 'Content to write' },
      },
      required: ['store', 'action', 'content'],
    },
    async execute(args: MemoryWriteArgs) {
      const key = args.store === 'user' ? 'USER.md' : 'MEMORY.md';
      if (args.action === 'remove') {
        await provider.sync([{ action: 'remove', key, substringMatch: args.content }], ctx);
      } else {
        await provider.sync(
          [{ action: args.action as 'add' | 'replace', key, content: args.content }],
          ctx,
        );
      }
      return { ok: true, value: `Wrote to ${key} (${args.action})` };
    },
  };
}
