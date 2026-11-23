import type { JobStore } from '@ethosagent/types';
import { BoundedLogBuffer } from './log-buffer';

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// --- Child-text persistence bounds -----------------------------------------
// The child's text is persisted WHILE it runs so a crash mid-job does not lose
// everything it wrote. Three constants bound that, and each answers a different
// failure mode — do not collapse them into one:
//   CHARS  — one row per token would be write amplification of ~2000x. Buffer
//            until a chunk is worth a row.
//   MS     — a slow, chatty child would otherwise sit under the char threshold
//            for minutes with nothing durable. Time-bounds the loss window.
//   ROWS   — the only unbounded axis left is a child that writes forever. Past
//            the cap the stream stops growing and says so, once.
const TEXT_CHUNK_CHARS = 2_000;
const TEXT_FLUSH_MS = 5_000;
const TEXT_MAX_EVENTS = 100;

// --- Runner-log persistence bounds (I-LOG1) ---------------------------------
// A runner subprocess's own stdout/stderr is batched into `runner_log`
// job_events rather than one write per line: `@ethosagent/sqlite` is
// synchronous, so a chatty child would otherwise burst many blocking writes
// onto the executor's event loop. Two independent triggers flush a batch,
// whichever fires first — the same two-trigger shape `createTextSink` already
// uses for the child's own text output, for the same reason:
const LOG_BATCH_LINES = 20;
const LOG_BATCH_MS = 250;
// Hard cap on lines held in the IN-MEMORY buffer awaiting flush, so a
// subprocess that out-produces the flush cadence cannot grow memory without
// bound. In normal operation the batch triggers above empty this well before
// it's ever reached — it's a defensive backstop, not the retention cap. The
// OLDEST buffered line is dropped first here — for a log tail, the freshest
// output is the one worth keeping.
const LOG_MAX_BUFFERED_LINES = 100;
// Separate concern: the total number of runner-log LINES persisted to the
// store over a job's whole lifetime. Without this, a long-running chatty
// job's `runner_log` rows would accumulate in `job_events` forever — the
// same unbounded-growth failure mode `TEXT_MAX_EVENTS` above already guards
// against for `text` rows. Matches `task_logs`'s existing `tail` cap (100
// events) and `TEXT_MAX_EVENTS`, per the plan's Open Question 4
// recommendation. Uses the SAME cap-and-stop policy as `TEXT_MAX_EVENTS`
// (write one final marker, then stop), not oldest-eviction: evicting already
// -persisted rows would need a delete/prune method on `JobStore`, which the
// interface doesn't have — out of scope here, and worth a follow-up if a
// true "keep the freshest" retention policy is wanted later.
const LOG_TOTAL_MAX_LINES = 100;

/**
 * Buffered writer for the child's text output. `push` accumulates and writes
 * a `text` event once a chunk is worth a row (size) or the loss window is
 * long enough (time); `flush` drains whatever is left. Both swallow store
 * errors — losing an audit row must never fail the job it describes.
 */
export function createTextSink(
  store: JobStore,
  jobId: string,
  log?: (m: string) => void,
): {
  push(t: string): Promise<void>;
  flush(): Promise<void>;
} {
  let buffer = '';
  let lastFlush = Date.now();
  let written = 0;
  let capNoted = false;

  const write = async (chunk: string, payload: Record<string, unknown> = {}): Promise<void> => {
    try {
      await store.appendEvent(jobId, 'text', { text: chunk, ...payload });
    } catch (err) {
      log?.(`appendEvent(text) failed for ${jobId}: ${errMsg(err)}`);
    }
  };

  const drain = async (all: boolean): Promise<void> => {
    while (buffer.length > 0 && (all || buffer.length >= TEXT_CHUNK_CHARS)) {
      if (written >= TEXT_MAX_EVENTS) {
        buffer = '';
        if (!capNoted) {
          capNoted = true;
          written++;
          await write('', { truncated: true });
        }
        return;
      }
      const chunk = buffer.slice(0, TEXT_CHUNK_CHARS);
      buffer = buffer.slice(chunk.length);
      written++;
      await write(chunk);
    }
    lastFlush = Date.now();
  };

  return {
    async push(t: string): Promise<void> {
      buffer += t;
      // A stale buffer drains ENTIRELY (`all`) — a size-only drain would leave
      // the sub-chunk remainder in memory and reset the clock, so the
      // time-bound would never actually bound anything.
      const stale = Date.now() - lastFlush >= TEXT_FLUSH_MS;
      if (buffer.length >= TEXT_CHUNK_CHARS || stale) await drain(stale);
    },
    flush: () => drain(true),
  };
}

/**
 * Buffered writer for the runner subprocess's own stdout/stderr
 * (`JobRunnerContext.appendLog`, I-LOG1). Batches already-split lines into
 * one `runner_log` job_event per flush — either `LOG_BATCH_LINES` lines or
 * `LOG_BATCH_MS` have elapsed since the oldest still-buffered line, whichever
 * comes first. The in-memory buffer is bounded independently of the flush
 * cadence (`LOG_MAX_BUFFERED_LINES`, oldest dropped first) as a defensive
 * backstop. Separately, and this is the actual per-job retention cap:
 * `LOG_TOTAL_MAX_LINES` bounds how many lines get PERSISTED over the job's
 * whole life, same cap-and-stop shape as `TEXT_MAX_EVENTS` above — the batch
 * that crosses the cap is truncated to exactly the remaining budget (never
 * skipped entirely), then one marker row is written on the next flush and
 * the rest is dropped, so `job_events` can't grow without bound for a
 * long-running chatty job.
 * Swallows store errors — losing an audit row must never fail the job it
 * describes.
 */
export function createLogSink(
  store: JobStore,
  jobId: string,
  log?: (m: string) => void,
): {
  appendLog(stream: 'stdout' | 'stderr', line: string): void;
  flush(): Promise<void>;
} {
  const buffer = new BoundedLogBuffer(LOG_MAX_BUFFERED_LINES);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let totalWritten = 0;
  let cappedNoted = false;

  const doFlush = async (): Promise<void> => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (buffer.length === 0) return;
    const { entries, dropped } = buffer.drain();
    const remaining = LOG_TOTAL_MAX_LINES - totalWritten;
    if (remaining <= 0) {
      if (!cappedNoted) {
        cappedNoted = true;
        try {
          await store.appendEvent(jobId, 'runner_log', { lines: [], truncated: true });
        } catch (err) {
          log?.(`appendEvent(runner_log) failed for ${jobId}: ${errMsg(err)}`);
        }
      }
      return;
    }
    // The batch that crosses the cap is truncated to exactly the remaining
    // budget rather than skipped entirely — `totalWritten` must never exceed
    // `LOG_TOTAL_MAX_LINES` after this flush. If more lines arrive after this,
    // the NEXT call sees `remaining <= 0` and fires the truncation marker.
    const toWrite = entries.length > remaining ? entries.slice(0, remaining) : entries;
    totalWritten += toWrite.length;
    try {
      await store.appendEvent(jobId, 'runner_log', {
        lines: toWrite,
        ...(dropped > 0 ? { dropped } : {}),
      });
    } catch (err) {
      log?.(`appendEvent(runner_log) failed for ${jobId}: ${errMsg(err)}`);
    }
  };

  return {
    appendLog(stream: 'stdout' | 'stderr', line: string): void {
      buffer.push({ stream, line });
      if (buffer.length >= LOG_BATCH_LINES) {
        void doFlush();
        return;
      }
      if (!timer) {
        timer = setTimeout(() => void doFlush(), LOG_BATCH_MS);
        timer.unref?.();
      }
    },
    flush: () => doFlush(),
  };
}
