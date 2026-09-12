// B-T1. The nightly pass no longer applies an Expression change to a
// personality in `user` mode (the default when `evolution_approval_mode` is
// absent) — it queues the draft, and `ethos personality evolve <id>` offers it.
// These tests pin the offer surface: applied on `y`, discarded on `N`, and
// discarded unoffered when the Expression moved out from under the draft.

import { join } from 'node:path';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it, vi } from 'vitest';
import {
  clearPendingExpression,
  expressionHash,
  offerPendingExpression,
  PENDING_EXPRESSION_DIR,
  type PendingExpression,
  queuePendingExpression,
  readPendingExpression,
} from '../pending-expression';

const DATA_DIR = '/home/u/.ethos';
const BASE = 'I speak plainly and keep answers short.';

function pending(overrides: Partial<PendingExpression> = {}): PendingExpression {
  return {
    personalityId: 'sage',
    newExpression: 'I speak plainly, keep answers short, and lead with the answer.',
    rationale: 'recent sessions show the user asking for the answer first',
    evidenceRef: 'nightly:0.62@2026-06-17T00:00:00.000Z',
    baseHash: expressionHash(BASE),
    at: '2026-06-17T03:00:00.000Z',
    ...overrides,
  };
}

function pathFor(id: string): string {
  return join(DATA_DIR, PENDING_EXPRESSION_DIR, `${id}.json`);
}

describe('the pending-Expression queue', () => {
  it('round-trips a queued draft', async () => {
    const storage = new InMemoryStorage();
    const entry = pending();
    await queuePendingExpression(storage, DATA_DIR, entry);
    expect(await readPendingExpression(storage, DATA_DIR, 'sage')).toEqual(entry);
  });

  it('replaces an older draft rather than stacking a second one', async () => {
    const storage = new InMemoryStorage();
    await queuePendingExpression(storage, DATA_DIR, pending());
    await queuePendingExpression(
      storage,
      DATA_DIR,
      pending({ newExpression: 'a newer draft', at: '2026-06-18T03:00:00.000Z' }),
    );

    const read = await readPendingExpression(storage, DATA_DIR, 'sage');
    expect(read?.newExpression).toBe('a newer draft');
    expect(await storage.list(join(DATA_DIR, PENDING_EXPRESSION_DIR))).toEqual(['sage.json']);
  });

  it('treats an unparseable queue file as no draft at all', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(join(DATA_DIR, PENDING_EXPRESSION_DIR));
    await storage.write(pathFor('sage'), '{ not json');
    expect(await readPendingExpression(storage, DATA_DIR, 'sage')).toBeNull();

    await storage.write(pathFor('sage'), JSON.stringify({ rationale: 'no expression here' }));
    expect(await readPendingExpression(storage, DATA_DIR, 'sage')).toBeNull();
  });

  it('refuses a personality id that would escape the queue directory', async () => {
    const storage = new InMemoryStorage();
    await expect(readPendingExpression(storage, DATA_DIR, '../../keys')).rejects.toThrow();
  });

  it('clearing a draft that is not there is not an error', async () => {
    const storage = new InMemoryStorage();
    await expect(clearPendingExpression(storage, DATA_DIR, 'sage')).resolves.toBeUndefined();
  });
});

describe('offerPendingExpression', () => {
  it('applies the queued draft on y and removes the file', async () => {
    const storage = new InMemoryStorage();
    await queuePendingExpression(storage, DATA_DIR, pending());
    const apply = vi.fn(async (_pending: PendingExpression) => ({ revisionId: 'expr-rev-4' }));

    const result = await offerPendingExpression({
      storage,
      dataDir: DATA_DIR,
      personalityId: 'sage',
      currentExpression: BASE,
      confirm: async () => true,
      apply,
      log: () => {},
    });

    expect(result).toEqual({ outcome: 'applied', revisionId: 'expr-rev-4' });
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply.mock.calls[0]?.[0]).toMatchObject({
      newExpression: pending().newExpression,
      evidenceRef: pending().evidenceRef,
    });
    expect(await storage.exists(pathFor('sage'))).toBe(false);
  });

  it('discards the draft on N without applying it', async () => {
    const storage = new InMemoryStorage();
    await queuePendingExpression(storage, DATA_DIR, pending());
    const apply = vi.fn(async () => ({ revisionId: 'unused' }));

    const result = await offerPendingExpression({
      storage,
      dataDir: DATA_DIR,
      personalityId: 'sage',
      currentExpression: BASE,
      confirm: async () => false,
      apply,
      log: () => {},
    });

    expect(result).toEqual({ outcome: 'declined' });
    expect(apply).not.toHaveBeenCalled();
    expect(await storage.exists(pathFor('sage'))).toBe(false);
  });

  // A draft is a REWRITE of specific text, not a patch. If the Expression moved
  // after the draft was made — a hand edit, a revert, an `auto` apply — applying
  // it would silently throw that change away.
  it('discards a draft whose base Expression has changed, without offering it', async () => {
    const storage = new InMemoryStorage();
    await queuePendingExpression(storage, DATA_DIR, pending());
    const confirm = vi.fn(async () => true);
    const apply = vi.fn(async () => ({ revisionId: 'unused' }));
    const log = vi.fn();

    const result = await offerPendingExpression({
      storage,
      dataDir: DATA_DIR,
      personalityId: 'sage',
      currentExpression: `${BASE} And I use bullet points.`,
      confirm,
      apply,
      log,
    });

    expect(result).toEqual({ outcome: 'stale' });
    expect(confirm).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
    expect(await storage.exists(pathFor('sage'))).toBe(false);
    expect(log.mock.calls[0]?.[0]).toContain('older Expression');
  });

  it('is a no-op when nothing is queued', async () => {
    const storage = new InMemoryStorage();
    const confirm = vi.fn(async () => true);

    const result = await offerPendingExpression({
      storage,
      dataDir: DATA_DIR,
      personalityId: 'sage',
      currentExpression: BASE,
      confirm,
      apply: async () => ({ revisionId: 'unused' }),
      log: () => {},
    });

    expect(result).toEqual({ outcome: 'none' });
    expect(confirm).not.toHaveBeenCalled();
  });
});
