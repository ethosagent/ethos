import { randomUUID } from 'node:crypto';
import type { ToolContext } from '@ethosagent/types';
import type { CallHandle } from './protocol';

/**
 * What a live call lends the host: the call's own handles. A tool call lends
 * its whole `ToolContext`; a filter, evaluator, slash or CLI call lends the
 * part it has (a `Partial`).
 */
export type LiveCall = Partial<ToolContext> & { output?: CommandOutput };

/** Where a slash, CLI or command call's `send`/`stdout`/`stderr`/`emit` go (reverse notifications). */
export interface CommandOutput {
  send(text: string): void | Promise<void>;
  stdout(text: string): void;
  stderr(text: string): void;
  emit(text: string): void;
}

/**
 * Handles for the reverse capability calls of in-flight calls (plan §5.6).
 * A handle maps to that call's live context and is revoked in a `finally`
 * when the call settles, so a plugin cannot keep a turn's storage afterwards.
 * One table per host: a handle from another host never resolves.
 */
export class CallHandleTable {
  private readonly live = new Map<CallHandle, LiveCall>();
  private readonly cleanups = new Map<CallHandle, Array<() => void | Promise<void>>>();

  open(ctx: LiveCall): CallHandle {
    const handle = randomUUID();
    this.live.set(handle, ctx);
    return handle;
  }

  /** The live context, or undefined when the handle is unknown or revoked. */
  get(handle: unknown): LiveCall | undefined {
    return typeof handle === 'string' ? this.live.get(handle) : undefined;
  }

  /** Runs `fn` when the handle is revoked (the attachment copies of a call, for one). */
  onRevoke(handle: CallHandle, fn: () => void | Promise<void>): void {
    const list = this.cleanups.get(handle) ?? [];
    list.push(fn);
    this.cleanups.set(handle, list);
  }

  revoke(handle: CallHandle): void {
    this.live.delete(handle);
    const fns = this.cleanups.get(handle);
    this.cleanups.delete(handle);
    for (const fn of fns ?? []) {
      void Promise.resolve()
        .then(fn)
        .catch(() => undefined);
    }
  }

  get size(): number {
    return this.live.size;
  }
}
