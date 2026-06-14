export interface InjectionVerdict {
  containsInstructions: boolean;
  confidence: number;
  reason?: string;
  source: 'llm' | 'pattern-fallback';
}

export type InjectionClassifier = (input: { content: string }) => Promise<InjectionVerdict>;

export interface InjectionDefenseKit {
  prelude: string;
  downgradeRejectionMessage: string;
  sanitize(content: string): string;
  wrapUntrusted(input: { content: string; toolName: string; source?: string }): {
    content: string;
    strippedTokens: number;
  };
  shortPatternCheck(content: string): {
    containsInstructions: boolean;
    hits: Array<{ rule: string }>;
  };
  c2PatternCheck(content: string): { containsInstructions: boolean };
  resolveDowngradedTools(names?: string[] | 'auto'): Set<string>;
  classifier?: InjectionClassifier;
}

export interface RedactionKit {
  redactPii(text: string, extraPatterns?: string[]): string;
  redactString(text: string): string;
  detectSecrets(text: string): Array<{ label: string }>;
}

export type ScopedStorageFactory = (
  base: import('./storage').Storage,
  scope: { read: string[]; write: string[] },
) => import('./storage').Storage;

export type WatcherDecision =
  | { action: 'allow' }
  | { action: 'pause' | 'force_approval' | 'terminate'; rule: string; reason: string };

export interface WatcherEvent {
  type: string;
  toolName?: string;
  ok?: boolean;
  inputTokens?: number;
  outputTokens?: number;
  args?: unknown;
}

export interface AgentWatcher {
  observe(event: WatcherEvent): WatcherDecision;
  resetTurn(): void;
}

export interface AgentSafety {
  injection: InjectionDefenseKit;
  redaction: RedactionKit;
  scopedStorageFactory: ScopedStorageFactory;
  watcher?: AgentWatcher;
}
