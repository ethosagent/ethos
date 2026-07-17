import { InMemoryStorage } from '@ethosagent/storage-fs';
import { applyPatch, parsePatch, reversePatch } from 'diff';
import { describe, expect, it } from 'vitest';
import { HistoryStore } from '../history-store';

const DATA = '/root/.ethos';
const SCOPE = 'personality:muse';

function randomText(seed: number): string {
  // Deterministic pseudo-random content of varied size.
  const n = ((seed * 2654435761) >>> 0) % 6000;
  const lines: string[] = [];
  let x = seed >>> 0;
  for (let i = 0; i < n / 40 + 1; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    lines.push(`line-${i}-${x.toString(36)}`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Every-byte-recoverable property (§2.1 / M3 exit criterion, proven at M1):
 * for ANY mutation, the full pre-mutation content is always reachable — either
 * from a content-addressed blob, or by reversing the (untruncated) inline diff.
 * A hash-pair-only terminal state is structurally impossible.
 */
describe('property — pre-mutation content is never unreachable', () => {
  it('recovers the before-state for random before/after pairs across the diff cap', async () => {
    for (let seed = 1; seed <= 60; seed++) {
      const storage = new InMemoryStorage();
      // Vary the cap so some cases spill to a blob and some stay inline.
      const store = new HistoryStore({
        dataDir: DATA,
        storage,
        diffCapBytes: 200 + (seed % 5) * 800,
      });
      const before = randomText(seed);
      const after = randomText(seed + 10_000);

      const entry = await store.record({
        scopeId: SCOPE,
        key: 'MEMORY.md',
        actions: ['replace'],
        source: 'consolidation',
        sessionId: '',
        sessionKey: '',
        before,
        after,
      });
      expect(entry).not.toBeNull();
      if (!entry) continue;

      // The forbidden outcome: a truncated diff with no blob backing it.
      const truncated = entry.diff.includes('[diff truncated; before-state in blob');
      expect(truncated && !entry.blob).toBe(false);

      if (entry.blob) {
        const recovered = await store.readBlob(SCOPE, entry.blob);
        expect(recovered).toBe(before);
      } else {
        // Untruncated inline diff → reverse it against `after` to get `before`.
        const patches = parsePatch(entry.diff);
        const patch = patches[0];
        expect(patch).toBeDefined();
        if (!patch) continue;
        const recovered = applyPatch(after, reversePatch(patch));
        expect(recovered).toBe(before);
      }
    }
  });
});
