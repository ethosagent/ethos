import { isValidSecretName } from '@ethosagent/types';

// ---------------------------------------------------------------------------
// The shared named-secret rung resolver. One implementation for what used to
// be three hand-copied ladders (plan/phases/search-console.md §13 PR0):
//
//   - `selectSecretRef`       extensions/tools-x-search/src/index.ts
//   - `selectSecretRef`       extensions/tools-answer-engines/src/index.ts
//   - `selectYouTubeSecretRef` extensions/tools-social-search/src/youtube/constants.ts
//
// Each caller still builds its own rung list — which tools.yaml / toolSettings
// key names the binding is tool-specific, and this module deliberately knows
// nothing about tool names. What it owns is the semantics below.
//
// SEMANTICS: a rung whose secret name is absent, blank, or fails
// `isValidSecretName` FALLS THROUGH to the next rung; only when every rung
// fails is `defaultRef` returned.
//
// Why fall-through-on-invalid rather than "first rung whose object exists
// wins": the resolved string is interpolated as `${prefix}${name}`, so an
// unvalidated name is a path-traversal escape out of the tool's capability
// prefix grant (`SECRET_NAME_RE`, packages/types/src/secrets.ts). Validating
// here matches the write boundary — `toWebSearch`/`toXSearch`/`toEngineAsk` in
// apps/web-api/src/services/tool-settings.service.ts already apply
// `isValidSecretName` before a name is stored. This was `engine_ask`'s
// behaviour; adopting it for `x_search` and the YouTube pair is a deliberate
// behaviour change (§13 PR0, CLAUDE.md rule 5 — pick one, don't average).
//
// Pinned by packages/core/src/__tests__/tool-secret-ref.test.ts.
// ---------------------------------------------------------------------------

/**
 * One rung of a binding ladder. `secret` is a NAME only (e.g. `xai-main`) —
 * never a value — that resolves to `${prefix}${name}` in the vault.
 */
export interface ToolSecretRung {
  secret?: string;
}

export interface ResolveToolSecretRefOptions {
  /** Highest-priority rung first. `undefined` entries are skipped. */
  rungs: ReadonlyArray<ToolSecretRung | undefined>;
  /** Vault namespace the name hangs off, e.g. `providers/xai/`. */
  prefix: string;
  /** Returned when no rung names a valid secret, e.g. `providers/xai/apiKey`. */
  defaultRef: string;
}

/** Resolve a bound secret ref from an ordered rung list. See the module comment. */
export function resolveToolSecretRef(opts: ResolveToolSecretRefOptions): string {
  for (const rung of opts.rungs) {
    const name = rung?.secret?.trim();
    if (name && isValidSecretName(name)) return `${opts.prefix}${name}`;
  }
  return opts.defaultRef;
}
