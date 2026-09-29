// Every path the learning inbox owns, in one place.
//
// The whole tree lives under `<dataDir>/learning/`, which is backed up as
// `state` (`packages/wiring/src/backup/scopes.ts` `RULES`, added with B-T1 and
// pinned by its `scopes.test.ts`). Nothing here touches the filesystem — these
// are string builders, and every caller passes the result to a `Storage`.
//
// Ids that become path segments go through `assertSafeId` here rather than at
// each call site: a candidate id or a personality id reaching `join()` unchecked
// is the traversal `packages/types/src/id-validation.ts` exists to stop.

import { join } from 'node:path';
import { assertSafeId } from '@ethosagent/types';

/** `<dataDir>`-relative root of everything this package writes. */
export const LEARNING_DIR = 'learning';

export function learningDir(dataDir: string): string {
  return join(dataDir, LEARNING_DIR);
}

export function candidatesDir(dataDir: string): string {
  return join(learningDir(dataDir), 'candidates');
}

export function candidateDir(dataDir: string, candidateId: string): string {
  assertSafeId(candidateId, 'candidateId');
  return join(candidatesDir(dataDir), candidateId);
}

/** The candidate record itself. Written with `Storage.writeAtomic`. */
export function candidatePath(dataDir: string, candidateId: string): string {
  return join(candidateDir(dataDir, candidateId), 'candidate.json');
}

/** One scorecard per replay run of a candidate. `runId` is a safe id. */
export function replayRunPath(dataDir: string, candidateId: string, runId: string): string {
  assertSafeId(runId, 'runId');
  return join(candidateDir(dataDir, candidateId), `replay-${runId}.json`);
}

/** Filename → runId for `replay-<runId>.json`, or null for anything else. */
export function replayRunIdFromFilename(filename: string): string | null {
  const m = /^replay-(.+)\.json$/.exec(filename);
  return m?.[1] ?? null;
}

/** Append-only transition log. Every status change writes one line. */
export function auditPath(dataDir: string): string {
  return join(learningDir(dataDir), 'audit.jsonl');
}

/** Frozen replay cases, one directory per personality. */
export function casesDir(dataDir: string, personalityId: string): string {
  assertSafeId(personalityId, 'personalityId');
  return join(learningDir(dataDir), 'cases', personalityId);
}

export function casePath(dataDir: string, personalityId: string, caseId: string): string {
  assertSafeId(caseId, 'caseId');
  return join(casesDir(dataDir, personalityId), `${caseId}.json`);
}

/**
 * Written once the legacy queues have been drained, so the import runs on
 * first use and not on every boot. See `import-legacy.ts`.
 */
export function legacyImportMarkerPath(dataDir: string): string {
  return join(learningDir(dataDir), 'legacy-import.json');
}

/**
 * Self-amendments (plan personality-memory-boundary G2, D28): a SIBLING of
 * `candidates/`, never under it. `listCandidates` and every candidate path read
 * `candidatesDir` only, so an amendment is invisible to replay, auto-promotion
 * and `promote` — the separation IS G2-1 (a). Pinned by the amendment cases in
 * `__tests__/store.test.ts`, `auto-promotion.test.ts` and `promote.test.ts`.
 */
export function amendmentsDir(dataDir: string): string {
  return join(learningDir(dataDir), 'amendments');
}

export function amendmentDir(dataDir: string, amendmentId: string): string {
  assertSafeId(amendmentId, 'amendmentId');
  return join(amendmentsDir(dataDir), amendmentId);
}

/** The record itself (`AmendmentRecord`). Written with `Storage.writeAtomic`. */
export function amendmentProposalPath(dataDir: string, amendmentId: string): string {
  return join(amendmentDir(dataDir, amendmentId), 'proposal.json');
}

/**
 * The live definition bytes an apply replaced — what a rollback restores.
 * `prior.toolset.yaml` for a toolset amendment, `prior.config.yaml` for an
 * identity one (`AMENDMENT_TARGET_FILES`, packages/types/src/amendment.ts).
 */
export function amendmentPriorPath(
  dataDir: string,
  amendmentId: string,
  file: 'toolset.yaml' | 'config.yaml' = 'toolset.yaml',
): string {
  return join(amendmentDir(dataDir, amendmentId), `prior.${file}`);
}

/** Written before an apply's live write (the `promote.ts` snapshot order). */
export function amendmentAppliedPath(dataDir: string, amendmentId: string): string {
  return join(amendmentDir(dataDir, amendmentId), 'applied.json');
}

/**
 * The sentinel filing, apply, decline and rollback all hold. Its `*.lock` name
 * keeps it out of backups (`classifyPath`, packages/wiring/src/backup/scopes.ts).
 */
export function amendmentApplyLockPath(dataDir: string): string {
  return join(amendmentsDir(dataDir), '.apply.lock');
}
