// The replay arm's composition root (plan `trust-before-reach.md` Part 4,
// L-T3, Design section 3).
//
// A replay measures a learning candidate: the same frozen case runs twice, once
// on a loop that sees what is live (the BASELINE arm) and once on a loop that
// sees exactly one path differently (the CANDIDATE arm). L-T4 owns the cases,
// the scoring and the verdict; this module owns the two loops and the isolation
// between them and the operator's state.
//
// Why it lives in wiring and not in `@ethosagent/learning-inbox`: assembling an
// `AgentLoop` is `createAgentLoop`'s job, and wiring sits ABOVE extensions in
// the layer model (ARCHITECTURE.md §II). The inbox package owns the primitive
// (`OverlayStorage`) and stays dependency-light; this module is where that
// primitive meets a real loop.
//
// The three enforcers, named rather than assumed (rule 12):
//
//   1. `OverlayStorage` (`extensions/learning-inbox/src/overlay-storage.ts`) —
//      what the arm READS. One shadowed path; every write, append, remove,
//      rename, mkdir and chmod throws `BoundaryError`. BOTH arms take one: a
//      baseline is a measurement too, and must not write either.
//   2. `CreateAgentLoopOptions.replay` (`./index.ts`) — what the arm IS. The
//      overlay becomes `WiringContext.storage` AND the loop's own `storage`
//      handle; the session store becomes the injected in-memory one;
//      `disablePostTurnLearning` is forced on, so no `ImprovementFork` and no
//      memory capture; memory is wrapped read-only; the context log and content
//      store are left off.
//   3. `RunOptions.dryRun` (X-D6) — what stops the arm PUBLISHING.
//      `DefaultToolRegistry.executeParallel` (`packages/core/src/tool-registry.ts`)
//      returns `synthesizeDryRunResult` without calling `tool.execute`, so no
//      tool runs at all, and the outbox gate inside `executeSendMessage`
//      (`extensions/tools-messaging/src/index.ts`) never queues a row. The
//      overlay CANNOT cover that on its own: `outbox.db` is a raw SQLite path,
//      not a `Storage` path. `REPLAY_RUN_OPTIONS` below carries the flag the
//      runner must pass; a runner that drops it is running the candidate for
//      real.
//
// Pinned by `./__tests__/replay-isolation.test.ts`.

import { InMemorySessionStore } from '@ethosagent/core';
import { type OverlayShadow, OverlayStorage } from '@ethosagent/learning-inbox';
import { parseLivingSoul, serializeLivingSoul } from '@ethosagent/personalities';
import { FsStorage } from '@ethosagent/storage-fs';
import type { SessionStore, Storage } from '@ethosagent/types';
import {
  type CreateAgentLoopOptions,
  type CreateAgentLoopResult,
  createAgentLoop,
  type WiringConfig,
} from './index';

export type { OverlayShadow } from '@ethosagent/learning-inbox';

/**
 * The `RunOptions` fields a replay turn MUST carry, whichever arm it is.
 * `dryRun` is the publication gate (X-D6); `temperature: 0` is what makes two
 * arms comparable at all. The runner (L-T4) spreads this and adds the per-case
 * `sessionKey` (`replay:<cid>:<arm>:<caseId>`, one of X-D7's never-learned
 * prefixes) and `dryRunMaxToolCalls`.
 */
export const REPLAY_RUN_OPTIONS = { dryRun: true, temperature: 0 } as const;

/** The candidate fields a shadow is built from — all L-T4 needs to pass. */
export interface ReplayCandidateRef {
  kind: 'skill' | 'expression';
  /** The live path the candidate would land on (`LearningCandidate.destination`). */
  destination: string;
  /** The candidate's own bytes: a whole skill file, or an Expression region. */
  content: string;
}

/**
 * The one path a replay arm sees differently.
 *
 *  - A SKILL candidate shadows its `destination` with its own bytes. When the
 *    candidate is a create, the overlay also makes the file appear in
 *    `listEntries`, which is what `UniversalScanner.discoverFiles`
 *    (`extensions/skills/src/universal-scanner.ts`) walks — a skill it does not
 *    list is a skill the model never sees.
 *  - An EXPRESSION candidate shadows `soulFile` with
 *    `serializeLivingSoul({ core, expression: candidate, learningLog })` read
 *    from the CURRENT file, so Core and the learning log are byte-identical to
 *    disk and only the Expression region differs. That is the whole safety
 *    claim of Expression evolution: Core is out of reach (`living-soul.ts`
 *    grammar; `extensions/personalities/src/__tests__/living-soul-core-invariant.test.ts`).
 *
 * Throws when an Expression candidate's `destination` does not exist: a
 * personality with no SOUL.md has no Core to preserve, and inventing one would
 * measure a soul nobody wrote.
 */
export async function shadowForCandidate(
  candidate: ReplayCandidateRef,
  deps: { storage: Storage },
): Promise<OverlayShadow> {
  if (candidate.kind === 'skill') {
    return { path: candidate.destination, content: candidate.content };
  }
  const body = await deps.storage.read(candidate.destination);
  if (body === null) {
    throw new Error(
      `Cannot build an Expression shadow: ${candidate.destination} does not exist. ` +
        `A replay preserves the Core that is on disk; there is none to preserve.`,
    );
  }
  const current = parseLivingSoul(body);
  return {
    path: candidate.destination,
    content: serializeLivingSoul({
      core: current.core,
      expression: candidate.content,
      learningLog: current.learningLog,
    }),
  };
}

/**
 * Everything `createAgentLoop` takes, minus the four fields a replay arm
 * decides for itself. `oneShot` and `disableDocker` are fixed (Design section
 * 3): an arm runs one turn and exits, and a measurement has no business
 * starting containers.
 */
export type CreateReplayLoopOptions = Omit<
  CreateAgentLoopOptions,
  'replay' | 'oneShot' | 'disableDocker' | 'disablePostTurnLearning'
> & {
  /**
   * The path this arm sees differently, or `null` for the BASELINE arm — which
   * still gets an overlay, so it cannot write either.
   */
  shadow: OverlayShadow | null;
  /**
   * The arm's session store. Defaults to a fresh `InMemorySessionStore`, the
   * same isolation `ImprovementFork.run` step 4 uses. Passed in when the runner
   * wants to seed a case's context messages before the turn.
   */
  session?: SessionStore;
  /**
   * The storage the overlay decorates. Defaults to the real filesystem — a
   * replay reads the operator's live personalities, skills and memory; that is
   * the point. Injected in tests.
   */
  baseStorage?: Storage;
};

/**
 * Assemble one arm of a replay. The caller disposes it (`result.dispose()`) —
 * `createAgentLoop` opens sqlite handles for every loop, replay or not.
 */
export async function createReplayLoop(
  config: WiringConfig,
  opts: CreateReplayLoopOptions,
): Promise<CreateAgentLoopResult> {
  const { shadow, session, baseStorage, ...rest } = opts;
  const storage = new OverlayStorage(baseStorage ?? new FsStorage(), shadow);
  return createAgentLoop(config, {
    ...rest,
    oneShot: true,
    disableDocker: true,
    replay: { storage, session: session ?? new InMemorySessionStore() },
  });
}
