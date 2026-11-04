import { randomUUID } from 'node:crypto';
import type { ToolContext } from '@ethosagent/types';
import type { CallHandle } from './protocol';

/**
 * Handles for the reverse capability calls of in-flight tool calls (plan §5.6).
 * A handle maps to that call's live `ToolContext` and is revoked in a `finally`
 * when the call settles, so a plugin cannot keep a turn's storage afterwards.
 * One table per host: a handle from another host never resolves.
 */
export class CallHandleTable {
  private readonly live = new Map<CallHandle, ToolContext>();

  open(ctx: ToolContext): CallHandle {
    const handle = randomUUID();
    this.live.set(handle, ctx);
    return handle;
  }

  /** The live context, or undefined when the handle is unknown or revoked. */
  get(handle: unknown): ToolContext | undefined {
    return typeof handle === 'string' ? this.live.get(handle) : undefined;
  }

  revoke(handle: CallHandle): void {
    this.live.delete(handle);
  }

  get size(): number {
    return this.live.size;
  }
}
