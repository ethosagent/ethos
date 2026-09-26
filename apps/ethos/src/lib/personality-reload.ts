// N3 (plan ux-feedback-and-config-clarity §4) — pre-turn personality refresh
// for the chat REPL, the same seam the gateway command's
// `personalityDirectory.refresh()` uses (apps/ethos/src/commands/gateway.ts):
// reload the registry from disk before each turn and name each failure and
// each reload instead of staying silent.
//
// Once per content change is the REGISTRY's contract, not re-implemented
// here: `FilePersonalityRegistry.loadOne` stamps the mtime fingerprint BEFORE
// parsing, so a still-broken directory contributes to `lastLoadReport` only
// on the call where its content changed, and `lastLoadReport` is replaced
// whole per call. Pinned by __tests__/chat-personality-reload.test.ts.

export interface PersonalityLoadReportLike {
  failures: Array<{ id: string; error: string }>;
  reloaded: Array<{ id: string; changed: string[] }>;
}

export interface ReloadablePersonalityRegistry {
  loadFromDirectory(dir: string): Promise<void>;
  /** `FilePersonalityRegistry.lastLoadReport` — optional so the plain
   *  `PersonalityRegistry` contract still satisfies this shape. */
  lastLoadReport?: PersonalityLoadReportLike;
}

/**
 * Build the refresh the REPL runs before each turn. Returns the dim lines to
 * print — empty when nothing changed. `getRegistry` is a getter so a `/model`
 * rebuild's fresh registry is picked up without rewiring.
 */
export function createPersonalityReloadNotifier(
  getRegistry: () => ReloadablePersonalityRegistry,
  dir: string,
): () => Promise<string[]> {
  return async () => {
    const registry = getRegistry();
    try {
      await registry.loadFromDirectory(dir);
    } catch {
      // loadFromDirectory still rejects when any directory failed, but every
      // good directory is already applied and `lastLoadReport` survives the
      // throw (FilePersonalityRegistry.loadFromDirectory) — the lines below
      // are the user-facing rendering of exactly that failure.
    }
    const report = registry.lastLoadReport;
    if (!report) return [];
    return [
      ...report.failures.map(
        (failure) => `[personality] ${failure.id}: ${failure.error} — serving last-good copy`,
      ),
      ...report.reloaded.map(
        (reload) => `[personality] ${reload.id} reloaded (${reload.changed.join(', ')} changed)`,
      ),
    ];
  };
}
