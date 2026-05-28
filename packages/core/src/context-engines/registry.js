// E4 — concrete ContextEngineRegistry. Built-ins register themselves at
// construction; plugin authors call `register` to add custom engines.
import { DropOldestEngine } from './drop-oldest';
import { ReferencePreservingEngine } from './reference-preserving';
import { SemanticSummaryEngine } from './semantic-summary';
export class DefaultContextEngineRegistry {
  engines = new Map();
  constructor(opts = {}) {
    this.register(new DropOldestEngine());
    this.register(
      opts.summarize
        ? new SemanticSummaryEngine({ summarize: opts.summarize })
        : new SemanticSummaryEngine(),
    );
    this.register(new ReferencePreservingEngine());
  }
  register(engine) {
    this.engines.set(engine.name, engine);
  }
  get(name) {
    return this.engines.get(name);
  }
  names() {
    return [...this.engines.keys()];
  }
}
