// A2A async task orchestration (plan §10 / §17 Phase 6).
//
// Two roles, two sides of the wire:
//
//   RESPONDER (this server) — A2aAsyncManager. `submit` dedupes on the
//   idempotency key, creates a `submitted` task, and runs the injected runner in
//   the BACKGROUND: `working` → `completed` / `failed`. If the request asked for
//   push-back, it then POSTs the result to the peer's OWN JSON-RPC server
//   through the injected push client; if delivery fails after retries the task
//   settles `peer-unreachable` (NOT `failed` — delivery, not execution, failed).
//
//   INITIATOR (the caller awaiting an async result) — A2aInitiatorTracker. It
//   owns the task-level TIMEOUT: if the push-back never arrives in time the task
//   settles `expired` (NOT `failed` — the initiator gave up waiting, the peer
//   did not error). `resolve` lands an arriving push-back as `completed`.
//
// Idempotency (plan §10): a retried `message/send` with the same key MUST NOT
// re-run the loop — tools run and state mutates, so a double `run()` is a real
// side effect. `submit` returns the prior/in-flight task and never calls the
// runner a second time.
//
// Layer-clean: imports `./task-store`, the `A2aTaskRunner` TYPE from `./rpc`
// (type-only — no runtime cycle), and `@ethosagent/types` for `AgentEvent`. No
// core, no extensions, no apps — the runner + push client are injected.

import type { AgentEvent } from '@ethosagent/types';
import type { A2aTaskRunner } from './rpc';
import { type A2aTask, type A2aTaskStore, isTerminalStatus, newTaskId } from './task-store';

// ---------------------------------------------------------------------------
// Shared AgentEvent → result mapping (plan §10 / Phase 5).
// ---------------------------------------------------------------------------

/**
 * Consume an AgentEvent stream: accumulate `text_delta` as the final text
 * (falling back to `done.text`); `error` → a failure reason. `thinking_delta`
 * and tool events are working updates and are NOT surfaced to the peer —
 * internal reasoning must not cross the trust boundary.
 */
export async function collectAgentRun(
  events: AsyncIterable<AgentEvent>,
): Promise<{ text: string; error?: string }> {
  let out = '';
  let doneText: string | null = null;
  let failure: string | undefined;
  for await (const event of events) {
    switch (event.type) {
      case 'text_delta':
        out += event.text;
        break;
      case 'done':
        doneText = event.text;
        break;
      case 'error':
        failure = event.error;
        break;
      default:
        break;
    }
  }
  const text = out.length > 0 ? out : (doneText ?? '');
  return failure !== undefined ? { text, error: failure } : { text };
}

// ---------------------------------------------------------------------------
// Push-back client (plan §10) — injected so it is stubbable in tests.
// ---------------------------------------------------------------------------

/** Where a push-back is delivered: the peer's JSON-RPC URL + the token to auth with. */
export interface A2aPushTarget {
  url: string;
  /** The token THIS agent holds for the peer (from gated reciprocation). */
  token?: string;
}

/** The push-back payload delivered to the initiator on async completion. */
export interface A2aPushPayload {
  taskId: string;
  status: A2aTask['status'];
  result?: string;
  error?: string;
}

/**
 * Delivers an async result back to the initiator's JSON-RPC server. Injected —
 * the default {@link FetchA2aPushClient} POSTs via `fetch`; tests pass a stub.
 * `push` MUST throw (or reject) on a delivery failure so the manager can retry.
 */
export interface A2aPushClient {
  push(target: A2aPushTarget, payload: A2aPushPayload): Promise<void>;
}

/** Default push client: POST the payload as a JSON-RPC notification to the peer. */
export class FetchA2aPushClient implements A2aPushClient {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async push(target: A2aPushTarget, payload: A2aPushPayload): Promise<void> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (target.token) headers.authorization = `Bearer ${target.token}`;
    const res = await this.fetchImpl(target.url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'tasks/pushResult',
        params: payload,
      }),
    });
    if (!res.ok) throw new Error(`push-back returned HTTP ${res.status}`);
  }
}

// ---------------------------------------------------------------------------
// Responder-side async manager
// ---------------------------------------------------------------------------

export interface A2aAsyncManagerOptions {
  taskStore: A2aTaskStore;
  runner: A2aTaskRunner;
  /** Injectable clock (ms epoch). Default `Date.now`. */
  now?: () => number;
  /** Push-back delivery client. Omit to disable push-back entirely. */
  pushClient?: A2aPushClient;
  /** Delivery attempts before settling `peer-unreachable`. Default 3. */
  pushRetries?: number;
  /** Called after a trace's task settles, so the delegation guard can free it. */
  onSettled?: (traceId: string) => void;
}

export interface SubmitAsyncArgs {
  personalityId: string;
  peerFingerprint: string;
  message: string;
  sessionKey: string;
  traceId: string;
  idempotencyKey: string;
  /** When set (and a push client is wired), deliver the result on completion. */
  pushBack?: A2aPushTarget;
}

/** The responder-side async task manager. */
export class A2aAsyncManager {
  private readonly opts: A2aAsyncManagerOptions;
  private readonly now: () => number;
  private readonly pushRetries: number;
  // task id → the background settle promise (lets callers/tests await settlement).
  private readonly running = new Map<string, Promise<A2aTask>>();

  constructor(opts: A2aAsyncManagerOptions) {
    this.opts = opts;
    this.now = opts.now ?? Date.now;
    this.pushRetries = opts.pushRetries ?? 3;
  }

  /**
   * Submit an async task. Dedupes on `(peerFingerprint, idempotencyKey)`: a
   * prior/in-flight task is returned WITHOUT re-running the loop. Otherwise a
   * `submitted` task is created and executed in the background.
   */
  async submit(args: SubmitAsyncArgs): Promise<A2aTask> {
    const existing = await this.opts.taskStore.findByIdempotencyKey(
      args.peerFingerprint,
      args.idempotencyKey,
    );
    if (existing) return existing;

    const task: A2aTask = {
      id: newTaskId(),
      status: 'submitted',
      createdAt: this.now(),
      idempotencyKey: args.idempotencyKey,
      traceId: args.traceId,
      peerFingerprint: args.peerFingerprint,
    };
    await this.opts.taskStore.create(task);
    this.running.set(task.id, this.execute(task, args));
    return task;
  }

  /** The background settle promise for a task (undefined once forgotten). */
  settled(taskId: string): Promise<A2aTask> | undefined {
    return this.running.get(taskId);
  }

  private async execute(task: A2aTask, args: SubmitAsyncArgs): Promise<A2aTask> {
    const store = this.opts.taskStore;
    try {
      await store.update(task.id, { status: 'working' });
      const { text, error } = await collectAgentRun(
        this.opts.runner.run(args.personalityId, args.message, { sessionKey: args.sessionKey }),
      );
      if (error !== undefined) {
        return await this.finalize(task, { status: 'failed', error });
      }
      await store.update(task.id, { status: 'completed', result: text });

      // Push-back delivery — a distinct failure axis from execution.
      if (args.pushBack && this.opts.pushClient) {
        const delivered = await this.deliver(args.pushBack, {
          taskId: task.id,
          status: 'completed',
          result: text,
        });
        if (!delivered) {
          return await this.finalize(task, { status: 'peer-unreachable', result: text });
        }
      }
      return await this.finalize(task, { status: 'completed', result: text });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return await this.finalize(task, { status: 'failed', error: message });
    }
  }

  private async finalize(task: A2aTask, patch: Partial<A2aTask>): Promise<A2aTask> {
    const updated = (await this.opts.taskStore.update(task.id, patch)) ?? { ...task, ...patch };
    this.running.delete(task.id);
    this.opts.onSettled?.(task.traceId);
    return updated;
  }

  private async deliver(target: A2aPushTarget, payload: A2aPushPayload): Promise<boolean> {
    const client = this.opts.pushClient;
    if (!client) return false;
    for (let attempt = 0; attempt < this.pushRetries; attempt++) {
      try {
        await client.push(target, payload);
        return true;
      } catch {
        // Retry until the budget is exhausted, then settle peer-unreachable.
      }
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// Initiator-side tracker — owns the task-level timeout (`expired`).
// ---------------------------------------------------------------------------

export interface A2aInitiatorTrackerOptions {
  taskStore: A2aTaskStore;
  /** Injectable clock (ms epoch). Default `Date.now`. */
  now?: () => number;
}

export interface OpenInitiatorArgs {
  peerFingerprint: string;
  traceId: string;
  idempotencyKey: string;
  /** How long to wait for the peer's push-back before settling `expired`. */
  timeoutMs: number;
}

export interface OpenedInitiatorTask {
  task: A2aTask;
  /** Resolves when the task settles — `completed` (push-back arrived) or `expired`. */
  settled: Promise<A2aTask>;
}

/**
 * Tracks an outbound async task the initiator is awaiting. It arms a timeout:
 * if {@link A2aInitiatorTracker.resolve} is not called with the push-back before
 * `timeoutMs`, the task settles `expired` — the initiator does not wait forever.
 */
export class A2aInitiatorTracker {
  private readonly opts: A2aInitiatorTrackerOptions;
  private readonly now: () => number;
  private readonly pending = new Map<
    string,
    { settle: (task: A2aTask) => void; timer: ReturnType<typeof setTimeout> }
  >();

  constructor(opts: A2aInitiatorTrackerOptions) {
    this.opts = opts;
    this.now = opts.now ?? Date.now;
  }

  async open(args: OpenInitiatorArgs): Promise<OpenedInitiatorTask> {
    const task: A2aTask = {
      id: newTaskId(),
      status: 'working',
      createdAt: this.now(),
      idempotencyKey: args.idempotencyKey,
      traceId: args.traceId,
      peerFingerprint: args.peerFingerprint,
    };
    await this.opts.taskStore.create(task);

    let settle!: (t: A2aTask) => void;
    const settled = new Promise<A2aTask>((resolve) => {
      settle = resolve;
    });
    const timer = setTimeout(() => {
      void this.expire(task.id);
    }, args.timeoutMs);
    // Do not keep the process alive solely for this timer.
    if (typeof timer === 'object' && timer && 'unref' in timer) timer.unref();
    this.pending.set(task.id, { settle, timer });
    return { task, settled };
  }

  /** Land an arriving push-back: settle the task `completed`. */
  async resolve(taskId: string, result: string): Promise<void> {
    const entry = this.pending.get(taskId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(taskId);
    const updated = await this.opts.taskStore.update(taskId, { status: 'completed', result });
    if (updated) entry.settle(updated);
  }

  private async expire(taskId: string): Promise<void> {
    const entry = this.pending.get(taskId);
    if (!entry) return;
    this.pending.delete(taskId);
    const updated = await this.opts.taskStore.update(taskId, { status: 'expired' });
    if (updated) entry.settle(updated);
  }
}

/** Re-export so callers can branch on terminal state without a second import. */
export { isTerminalStatus };
