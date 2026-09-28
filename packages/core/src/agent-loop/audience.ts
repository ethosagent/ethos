// The shared-audience rules for a running turn (plan
// personality-memory-boundary-and-self-amendment, G1). One module, called by
// every stage that enforces them, so "shared only narrows" is computed in one
// place:
//
//   - turn-setup resolves the audience (`resolveTurnAudience`), merge-stamps a
//     shared session (`sharedStampFor`) and unions the exclusion list into the
//     turn's `excludeTools` (`withSharedAudienceExclusions`);
//   - context-assembly skips the memory read and sets `PromptContext.isDm`;
//   - turn-end skips the memory flush (`memoryFlushForbidden`);
//   - both file boundaries refuse the private memory files
//     (`privateMemoryDenyFor` → `denyWhen` on `ScopedStorage` via turn-setup's
//     `fsReach`, and on `ScopedFsImpl` via `resolveCapabilities`).
//
// Pinned by `packages/core/src/__tests__/shared-audience.test.ts`.

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  type PrivateMemoryRoots,
  type PrivatePathDeny,
  privateMemoryPathDeny,
  type TurnAudience,
} from '@ethosagent/types';
import { withRealPaths } from '../scoped/scoped-fs';

/**
 * The `Session.metadata` key holding the sticky stamp. Its only value is
 * `'shared'`: a private turn never writes it, so a session can move private →
 * shared and never back (`sharedStampFor`).
 */
export const ROOM_AUDIENCE_METADATA_KEY = 'roomAudience';

/**
 * Tools a shared turn can neither see nor execute. Unioned into the turn's
 * `excludeTools` (`ToolFilterOpts.excludeTools`) by turn-setup, which the tool
 * registry applies at definition time AND at execution time, ahead of the
 * `alwaysInclude`, MCP and plugin bypasses (`DefaultToolRegistry.toDefinitions`
 * / `executeParallel`, packages/core/src/tool-registry.ts). Children inherit it
 * through `ToolContext.toolsetNarrowing.exclude`.
 *
 * `session_search` is deliberately absent: it reads the current session only.
 */
export const SHARED_AUDIENCE_EXCLUDED_TOOLS: readonly string[] = [
  // Private memory and other sessions.
  'memory_read',
  'memory_write',
  'session_list_by_date',
  'get_session_events',
  'get_observability',
  // Team memory (D4(a)): a group chat's members are not the team.
  'team_memory_read',
  'team_memory_write',
  'team_memory_search',
  // Writes a meeting transcript into personality memory (D5(a)).
  'meet_join',
  // A shell or exec tool bypasses Storage and the file-reach boundary (D6(a)).
  'terminal',
  'run_code',
  'process_start',
  'process_list',
  'process_logs',
  'process_stop',
  'process_wait',
  'process_watch',
  // Would carry a shared prompt somewhere it runs private (D20, D21).
  'dashboard_add_panel',
  'dashboard_update_panel',
  'route_to_agent',
  // Drafts distilled from private sessions (D22(a)).
  'skills_pending_list',
  'skills_pending_view',
  'skills_pending_approve',
  'skills_pending_reject',
];

/**
 * The running turn's audience: `'shared'` when the caller asked for it OR the
 * session already carries the sticky stamp; otherwise `'private'`. Absent
 * `requested` means private (D3). The only place the "shared only narrows" rule
 * is computed for a running turn.
 */
export function resolveTurnAudience(
  requested: TurnAudience | undefined,
  sessionMetadata: Record<string, unknown> | undefined,
): TurnAudience {
  if (requested === 'shared') return 'shared';
  return sessionMetadata?.[ROOM_AUDIENCE_METADATA_KEY] === 'shared' ? 'shared' : 'private';
}

/**
 * D8 — a DM from someone other than the platform's owner. `MEMORY.md` is the
 * owner's, so the turn runs as `'shared'` for everything this module governs
 * (no personality-scope read, `SHARED_AUDIENCE_EXCLUDED_TOOLS` excluded, no
 * flush, the file deny, children and jobs shared), EXCEPT that the sender's own
 * `user:<id>` profile is still read (`userMemoryOnly`). Driven by
 * `RunOptions.skipPersonalityMemory`, a per-turn narrowing that is NOT
 * persisted: the session's sticky stamp is computed from the caller's audience
 * before this, so the stranger's session is never stamped by it. Set by the
 * gateway (`Gateway.runTurn`); pinned by the D8 cases in
 * `packages/core/src/__tests__/shared-audience.test.ts` and
 * `extensions/gateway/src/__tests__/memory-boundary-e2e.test.ts`.
 */
export function withPersonalityMemoryWithheld(
  audience: TurnAudience,
  skipPersonalityMemory: boolean | undefined,
): { roomAudience: TurnAudience; userMemoryOnly: boolean } {
  if (audience === 'shared' || skipPersonalityMemory !== true) {
    return { roomAudience: audience, userMemoryOnly: false };
  }
  return { roomAudience: 'shared', userMemoryOnly: true };
}

/**
 * The metadata to write so a shared turn's session stays shared, or `undefined`
 * when nothing needs writing (a private turn, or an already stamped session).
 * MERGES into the existing metadata because `SessionStore.updateSession`
 * replaces `metadata` wholesale; never writes `'private'`.
 */
export function sharedStampFor(
  audience: TurnAudience,
  sessionMetadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (audience !== 'shared') return undefined;
  if (sessionMetadata?.[ROOM_AUDIENCE_METADATA_KEY] === 'shared') return undefined;
  return { ...(sessionMetadata ?? {}), [ROOM_AUDIENCE_METADATA_KEY]: 'shared' };
}

/**
 * The turn's `excludeTools` with `SHARED_AUDIENCE_EXCLUDED_TOOLS` unioned in on
 * a shared turn. A private turn gets `excludeTools` back unchanged (same
 * reference, possibly `undefined`), so its tool definitions stay byte-identical.
 */
export function withSharedAudienceExclusions(
  audience: TurnAudience,
  excludeTools: string[] | undefined,
): string[] | undefined {
  if (audience !== 'shared') return excludeTools;
  return [...new Set([...(excludeTools ?? []), ...SHARED_AUDIENCE_EXCLUDED_TOOLS])];
}

/**
 * True when the turn-end memory flush must not run: on a shared turn, and on
 * ANY turn whose `excludeTools` names `memory_write`. The flush dispatches
 * `memory_write` directly rather than through `executeParallel`, so without
 * this guard a surface exclusion of the tool would not stop it. Checked first
 * thing in `runMemoryFlush` (./turn-end.ts); pinned by
 * `packages/core/src/__tests__/turn-end-consolidation.test.ts`.
 */
export function memoryFlushForbidden(
  audience: TurnAudience | undefined,
  excludeTools: readonly string[] | undefined,
): boolean {
  return audience === 'shared' || (excludeTools?.includes('memory_write') ?? false);
}

/**
 * The Ethos state dirs a host that wires nothing still has: `~/.ethos` and,
 * when set, `ETHOS_STATE_DIR`. Mirror of `ethosStateDirs` in
 * `packages/storage-fs/src/sensitive-paths.ts` (core may not import storage-fs
 * at runtime) minus the realpaths, which {@link privateMemoryDenyFor} and the
 * definition-floor fallback in `resolveCapabilities` add via `withRealPaths`.
 */
export function defaultEthosStateDirs(): string[] {
  const dirs = [join(homedir(), '.ethos')];
  const override = process.env.ETHOS_STATE_DIR;
  if (override && resolve(override) !== dirs[0]) dirs.push(resolve(override));
  return dirs;
}

/**
 * The file-boundary deny predicate for a turn (G1-5): on a shared turn, a
 * `PrivatePathDeny` over `roots` (`privateMemoryPathDeny`, @ethosagent/types);
 * on a private turn, `undefined`, so private turns carry no predicate at all.
 * The state dirs judged are ALWAYS `roots.stateDirs` plus
 * {@link defaultEthosStateDirs} — the wiring's `dataDir`, `~/.ethos` and
 * `ETHOS_STATE_DIR` as one set, the set the definition floor uses — and every
 * state dir and extra root is widened with its realpath (`withRealPaths`,
 * ../scoped/scoped-fs.ts), so a symlinked state dir is private under its real
 * name too (verification round A2/A3). Absent `roots` is therefore the default
 * set — fail closed on the common layout rather than open. Called by
 * turn-setup (the turn's `fsReach.denyWhen` → `ScopedStorage`) and by
 * `resolveCapabilities` (every `ScopedFsImpl`); pinned by the G1-5 cases in
 * `packages/core/src/__tests__/shared-audience.test.ts`.
 */
export function privateMemoryDenyFor(
  audience: TurnAudience | undefined,
  roots: PrivateMemoryRoots | undefined,
): PrivatePathDeny | undefined {
  if (audience !== 'shared') return undefined;
  const stateDirs = withRealPaths([...(roots?.stateDirs ?? []), ...defaultEthosStateDirs()]);
  const extraRoots = withRealPaths(roots?.extraRoots ?? []);
  return privateMemoryPathDeny({ stateDirs, extraRoots });
}
