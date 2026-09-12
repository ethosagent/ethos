// The pending-Expression queue (plan `trust-before-reach.md` B-T1).
//
// `evolution_approval_mode` (packages/types/src/personality.ts) promises that a
// personality in `user` mode — the default when the field is absent — gets an
// Expression change only on explicit user approval. The nightly pass used to
// apply its draft straight through `FilePersonalityRegistry.evolveExpression`
// with no mode check anywhere on the path, so every nightly run rewrote SOUL.md
// unapproved. This is where the draft waits instead.
//
// One file per personality at `~/.ethos/learning/pending-expression/<id>.json`,
// written with `Storage.writeAtomic`. A newer draft REPLACES the older one: a
// draft is made from a window of evidence, the newer window is the better one,
// and two drafts for one personality is a queue nobody asked for.
//
// `baseHash` is the sha256 of the Expression the draft was written against. A
// draft is a rewrite of specific text, not a patch — if the Expression moved
// underneath it (a hand edit, an `ethos personality revert`, an `auto` apply),
// applying the draft would silently discard that change. `offerPendingExpression`
// discards the draft instead, and says so.
//
// The queue is backed up: `learning` → `state` in
// `packages/wiring/src/backup/scopes.ts` `RULES`, pinned by its `scopes.test.ts`.

import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { assertSafeId, type Storage } from '@ethosagent/types';

/** A drafted Expression parked for explicit approval. */
export interface PendingExpression {
  personalityId: string;
  /** The drafted Expression, verbatim — what `evolveExpression` would write. */
  newExpression: string;
  /** The drafter's rationale. Shown above the diff. */
  rationale: string;
  /** Provenance of the evidence it was drafted from, e.g. `nightly:0.62@<window>`. */
  evidenceRef: string;
  /** sha256 of the Expression this draft was written against. */
  baseHash: string;
  /** When it was queued (ISO 8601). */
  at: string;
}

/** `<dataDir>`-relative directory holding the queue. */
export const PENDING_EXPRESSION_DIR = join('learning', 'pending-expression');

/** The base-Expression fingerprint a queued draft is validated against. */
export function expressionHash(expression: string): string {
  return createHash('sha256').update(expression, 'utf8').digest('hex');
}

function pendingDir(dataDir: string): string {
  return join(dataDir, PENDING_EXPRESSION_DIR);
}

function pendingPath(dataDir: string, id: string): string {
  assertSafeId(id, 'personalityId');
  return join(pendingDir(dataDir), `${id}.json`);
}

/** Park a draft, replacing whatever was queued for this personality before. */
export async function queuePendingExpression(
  storage: Storage,
  dataDir: string,
  pending: PendingExpression,
): Promise<void> {
  const path = pendingPath(dataDir, pending.personalityId);
  await storage.mkdir(pendingDir(dataDir));
  await storage.writeAtomic(path, JSON.stringify(pending, null, 2));
}

/**
 * Read the queued draft. Tolerant: a missing or malformed file returns null —
 * a queue entry nobody can parse is a queue entry nobody can approve, and it
 * must not stop `ethos personality evolve` from drafting a fresh one.
 */
export async function readPendingExpression(
  storage: Storage,
  dataDir: string,
  id: string,
): Promise<PendingExpression | null> {
  const raw = await storage.read(pendingPath(dataDir, id));
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const rec = parsed as Record<string, unknown>;
  const str = (k: string): string | null =>
    typeof rec[k] === 'string' ? (rec[k] as string) : null;
  const newExpression = str('newExpression');
  const baseHash = str('baseHash');
  if (newExpression === null || baseHash === null) return null;
  return {
    personalityId: str('personalityId') ?? id,
    newExpression,
    rationale: str('rationale') ?? '',
    evidenceRef: str('evidenceRef') ?? '',
    baseHash,
    at: str('at') ?? '',
  };
}

/**
 * Drop the queued draft. Idempotent — `Storage.remove` throws on a missing
 * path (`FsStorage` calls `rm` without `force`), so the existence check is the
 * idempotency, not a nicety.
 */
export async function clearPendingExpression(
  storage: Storage,
  dataDir: string,
  id: string,
): Promise<void> {
  const path = pendingPath(dataDir, id);
  if (await storage.exists(path)) await storage.remove(path);
}

export type PendingOffer =
  | { outcome: 'none' }
  | { outcome: 'stale' }
  | { outcome: 'declined' }
  | { outcome: 'applied'; revisionId: string };

/**
 * Offer the queued draft for approval. Whatever the answer, the file is gone
 * afterwards: `y` applies it through `apply` (which the caller routes to
 * `evolveExpression`), `N` discards it, and a draft whose `baseHash` no longer
 * matches the live Expression is discarded unoffered with a notice.
 */
export async function offerPendingExpression(args: {
  storage: Storage;
  dataDir: string;
  personalityId: string;
  /** The live Expression, to validate `baseHash` against. */
  currentExpression: string;
  /** Render the proposal and ask. `true` applies. */
  confirm(pending: PendingExpression): Promise<boolean>;
  apply(pending: PendingExpression): Promise<{ revisionId: string }>;
  log(msg: string): void;
}): Promise<PendingOffer> {
  const { storage, dataDir, personalityId } = args;
  const pending = await readPendingExpression(storage, dataDir, personalityId);
  if (!pending) return { outcome: 'none' };

  if (pending.baseHash !== expressionHash(args.currentExpression)) {
    await clearPendingExpression(storage, dataDir, personalityId);
    args.log(
      `Discarded a queued Expression draft for "${personalityId}": it was written against an older Expression, which has changed since. Re-run to draft a fresh one.`,
    );
    return { outcome: 'stale' };
  }

  const approved = await args.confirm(pending);
  await clearPendingExpression(storage, dataDir, personalityId);
  if (!approved) {
    args.log('Aborted — no changes. The queued draft was discarded.');
    return { outcome: 'declined' };
  }
  const { revisionId } = await args.apply(pending);
  return { outcome: 'applied', revisionId };
}
