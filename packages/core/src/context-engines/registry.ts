// E4 — concrete ContextEngineRegistry. Built-ins register themselves at
// construction; plugin authors call `register` to add custom engines.

import type { ContextEngine, ContextEngineRegistry } from '@ethosagent/types';
import { DropOldestEngine } from './drop-oldest';
import { ReferencePreservingEngine } from './reference-preserving';
import { SemanticSummaryEngine, type SummarizerFn } from './semantic-summary';

export interface DefaultContextEngineRegistryOptions {
  /** Optional summarizer wired into the SemanticSummaryEngine. Without it
   *  that engine falls back to a placeholder summary (no LLM call). */
  summarize?: SummarizerFn;
}

export class DefaultContextEngineRegistry implements ContextEngineRegistry {
  private readonly engines = new Map<string, ContextEngine>();

  constructor(opts: DefaultContextEngineRegistryOptions = {}) {
    this.register(new DropOldestEngine());
    this.register(
      opts.summarize
        ? new SemanticSummaryEngine({ summarize: opts.summarize })
        : new SemanticSummaryEngine(),
    );
    this.register(new ReferencePreservingEngine());
  }

  register(engine: ContextEngine): void {
    this.engines.set(engine.name, engine);
  }

  get(name: string): ContextEngine | undefined {
    return this.engines.get(name);
  }

  names(): string[] {
    return [...this.engines.keys()];
  }
}
