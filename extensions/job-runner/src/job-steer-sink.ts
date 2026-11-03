import type { JobSteer, SteerEntry, SteerSink } from '@ethosagent/types';

/**
 * The SteerSink a background run hands its runner (plan background-job-steer
 * D1/D4). The durable queue is `job_steers` in jobs.db; the executor's observe
 * tick copies pending rows in with `enqueue`, the runner's harness drains them
 * synchronously at its seams, and the executor reports the drained ids back to
 * the store (`takeDrainedIds` -> `JobStore.markSteersRead`).
 *
 * `push` is refused on purpose: every steer goes through `JobStore.addSteer`,
 * so nothing bypasses the cap, the length bound or the event row.
 */
export interface JobSteerSink extends SteerSink {
  /** Queue steers read from the store. Ids at or below `lastSeenId` are ignored (idempotent). */
  enqueue(steers: readonly JobSteer[]): void;
  /** Ids drained since the last call, in drain order. Clears the record. */
  takeDrainedIds(): number[];
  /** Highest steer id ever enqueued; the cursor for the next store read. */
  readonly lastSeenId: number;
}

export function createJobSteerSink(): JobSteerSink {
  const queue: JobSteer[] = [];
  let drained: number[] = [];
  let lastSeenId = 0;
  const take = (): JobSteer[] => {
    const taken = queue.splice(0);
    for (const s of taken) drained.push(s.id);
    return taken;
  };
  return {
    push: () => false,
    pushEntry: () => false,
    drain: () => take().map((s) => s.text),
    drainEntries: (): SteerEntry[] => take().map((s) => ({ text: s.text })),
    depth: () => queue.length,
    enqueue(steers) {
      if (steers.length === 0) return;
      for (const s of [...steers].sort((a, b) => a.id - b.id)) {
        if (s.id <= lastSeenId) continue;
        lastSeenId = s.id;
        queue.push(s);
      }
    },
    takeDrainedIds() {
      const ids = drained;
      drained = [];
      return ids;
    },
    get lastSeenId() {
      return lastSeenId;
    },
  };
}
