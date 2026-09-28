// The shared-audience rules for a running turn (plan
// personality-memory-boundary-and-self-amendment, G1). One module, called by
// every stage that enforces them, so "shared only narrows" is computed in one
// place:
//
//   - turn-setup resolves the audience (`resolveTurnAudience`), merge-stamps
//     the session (`sessionAudienceStampFor`, ../chat-audience.ts) and unions
//     the exclusion list into the turn's `excludeTools`
//     (`withSharedAudienceExclusions`);
//   - context-assembly skips the memory read and sets `PromptContext.isDm`;
//   - turn-end skips the memory flush (`memoryFlushForbidden`);
//   - both file boundaries refuse everything under the state dir but the
//     turn's own `files/`, `ui/`, `SOUL.md` and the skills, and private memory
//     everywhere (`sharedTurnDenyFor` → `denyWhen` on `ScopedStorage` via
//     turn-setup's `fsReach`, and on `ScopedFsImpl` via `resolveCapabilities`).
//
// Pinned by `packages/core/src/__tests__/shared-audience.test.ts`.

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  type PrivateMemoryRoots,
  type PrivatePathDeny,
  sharedTurnPathDeny,
  type TurnAudience,
} from '@ethosagent/types';
import { withRealPaths } from '../scoped/scoped-fs';

/**
 * The `Session.metadata` key holding the session's judged audience. `'shared'`
 * is the sticky stamp: once written, every later turn in the session is shared
 * (`resolveTurnAudience`). `'private'` is a JUDGEMENT, not a widening: it is
 * written only onto an unstamped session whose key shape alone would read as
 * shared (a Discord or email DM the gateway judged private at run time), so
 * post-turn readers stop guessing from the key (verification round B3). It
 * never overrides `'shared'`, and `resolveTurnAudience` reads it as "no
 * stamp". Written by `sessionAudienceStampFor` (../chat-audience.ts).
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
  // `run_tests` and `lint` take a free-form `command` run under `bash -c` on the
  // host (`makeCommandTool`, extensions/tools-code/src/index.ts) — a shell by
  // another name (verification round B1). Every tool declaring
  // `capabilities.process` must be listed here or justified in
  // `packages/wiring/src/__tests__/shared-audience-process-tools.test.ts`.
  'terminal',
  'run_code',
  'run_tests',
  'lint',
  'process_start',
  'process_list',
  'process_logs',
  'process_stop',
  'process_wait',
  'process_watch',
  // Would carry a shared prompt somewhere it runs private (D20, D21): a
  // dashboard panel prompt (added, edited, imported, or re-parameterised) is
  // refreshed by a private turn, and a mesh peer runs what it is sent private
  // (verification round B12/B14).
  'dashboard_add_panel',
  'dashboard_update_panel',
  'dashboard_import',
  'dashboard_set_params',
  'route_to_agent',
  'dispatch_team',
  'broadcast_to_agents',
  // Returns panel content a private turn refreshed (verification round B13).
  'dashboard_export',
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
 * `RunOptions.skipPersonalityMemory`, a per-turn narrowing that never NARROWS
 * a later turn: the session's sticky stamp is computed from the caller's
 * audience before this, so the stranger's session is never stamped shared by
 * it. What IS persisted is the `personalityMemoryWithheld` marker
 * (`sessionAudienceStampFor`, ../chat-audience.ts), read only by post-turn
 * learners through `turnWasShared` (verification round B2). Set by the
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
 * at runtime) minus the realpaths, which {@link sharedTurnDenyFor} and the
 * definition-floor fallback in `resolveCapabilities` add via `withRealPaths`.
 */
export function defaultEthosStateDirs(): string[] {
  const dirs = [join(homedir(), '.ethos')];
  const override = process.env.ETHOS_STATE_DIR;
  if (override && resolve(override) !== dirs[0]) dirs.push(resolve(override));
  return dirs;
}

/**
 * The file-boundary deny predicate for a turn (G1-5, widened by verification
 * round E4): on a shared turn, `sharedTurnPathDeny` (@ethosagent/types) —
 * a shared turn can read nothing under the Ethos state directory except its
 * own `files/`, `ui/`, `SOUL.md` and the skills, and no private memory
 * anywhere (the vault root included); on a private turn, `undefined`, so
 * private turns carry no predicate at all. `self` is the turn's personality
 * id (absent → nothing under `personalities/` is allowed). The state dirs
 * judged are ALWAYS `roots.stateDirs` plus {@link defaultEthosStateDirs} —
 * the wiring's `dataDir`, `~/.ethos` and `ETHOS_STATE_DIR` as one set, the
 * set the definition floor uses — and every state dir and extra root is
 * widened with its realpath (`withRealPaths`, ../scoped/scoped-fs.ts), so a
 * symlinked state dir is judged under its real name too (verification round
 * A2/A3); case and the macOS `/System/Volumes/Data` firmlink are folded by
 * the predicate (`foldForDeny`). Absent `roots` is therefore the default set
 * — fail closed on the common layout rather than open. Called by turn-setup
 * (the turn's `fsReach.denyWhen` → `ScopedStorage`) and by
 * `resolveCapabilities` (every `ScopedFsImpl`); pinned by the G1-5 and E4
 * cases in `packages/core/src/__tests__/shared-audience.test.ts`.
 */
export function sharedTurnDenyFor(
  audience: TurnAudience | undefined,
  roots: PrivateMemoryRoots | undefined,
  self: string | undefined,
): PrivatePathDeny | undefined {
  if (audience !== 'shared') return undefined;
  const stateDirs = withRealPaths([...(roots?.stateDirs ?? []), ...defaultEthosStateDirs()]);
  const extraRoots = withRealPaths(roots?.extraRoots ?? []);
  return sharedTurnPathDeny({ stateDirs, extraRoots }, self ?? '');
}
