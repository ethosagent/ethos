import type { StoredMessage } from './session';

export interface PromptContext {
  sessionId: string;
  sessionKey: string;
  platform: string;
  model: string;
  history: StoredMessage[];
  workingDir?: string;
  isDm: boolean;
  turnNumber: number;
  personalityId?: string;
  /**
   * The sender's opaque user id (`RunOptions.userId`, from IdentityMap), set
   * by `assembleContext` (packages/core/src/agent-loop/stages/context-assembly.ts)
   * when the host resolved one. Absent on hosts with no sender identity (CLI,
   * web). The first-contact injector reads it to find the sender's
   * `user:<id>` USER.md (`createFirstContactInjector`, packages/wiring).
   */
  userId?: string;
  /**
   * Who started this turn and where it runs — the same values the turn's
   * `ToolContext` carries, copied from `RunOptions` (and the RESOLVED
   * `roomAudience`) by `assembleContext`, verbatim, no fallback. They let an
   * injector apply a tool-side gate before the model sees the prompt: the
   * birth-ritual injector runs `gateRefusal` (packages/wiring/src/
   * amendments.ts) over them (`createBirthRitualInjector`, packages/wiring/src/
   * birth-ritual.ts). Anything rendered from them must go in an `append`
   * section, never the static prefix.
   */
  initiator?: import('./audience').TurnInitiator;
  roomAudience?: import('./audience').TurnAudience;
  jobId?: string;
  reviewOfJobId?: string;
  agentId?: string;
  dryRun?: boolean;
  /** Phase 4 — small-window mode. When true, injectors that support an index /
   *  content split (e.g. skills) must emit the compact index form. Derived from
   *  static inputs (model window + fixed overhead), constant across turns, so it
   *  does not break prefix caching. */
  skillsIndexMode?: boolean;
  // Mutable side-channel: injectors write metadata here; AgentLoop emits it as context_meta event.
  meta?: Record<string, unknown>;
}

export interface InjectionResult {
  content: string;
  position?: 'prepend' | 'append';
  section?: string;
}

export interface ContextInjector {
  readonly id: string;
  readonly priority: number;
  inject(ctx: PromptContext): Promise<InjectionResult | null>;
  shouldInject?(ctx: PromptContext): boolean;
}
