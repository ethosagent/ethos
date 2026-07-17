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
