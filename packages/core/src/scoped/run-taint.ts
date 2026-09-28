import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The run taint of the post-untrusted-read downgrade (Ch.3d), made visible to
 * the async work a tool call of that run starts (V2-SEC-2).
 *
 * The taint itself lives in one `AgentLoop.run()`'s downgrade state
 * (`DowngradeState.untrustedSeen`, `../agent-loop/stages/per-call-enforcement.ts`).
 * A tool call can persist through something that is NOT that run: a sub-agent
 * run it starts (`delegate_task`, `mixture_of_agents`), or a filesystem write
 * through `ScopedFsImpl`. Both read the taint of the call they happen inside
 * from here instead of being handed it, because a `ToolContext` field would
 * not survive the transport hop (`LocalToolTransport` rebuilds the context
 * field by field) and because every nested run inherits it this way, not only
 * the ones whose tool remembered to forward it.
 *
 * `runToolsInTaintScope` (per-call-enforcement.ts) opens a link around each
 * tool batch and CLOSES it when the batch settles. Async work a tool kicks off
 * that outlives its call (an executor loop, a timer) keeps the store but sees
 * a closed link, so it inherits nothing — pinned by "a run started after the
 * tainted batch ended does not inherit it" in
 * `../__tests__/downgrade-derived-runs.test.ts`.
 */
export interface RunTaintLink {
  /** The owning run's taint; read live, so a later taint in that run is seen. */
  readonly state: { untrustedSeen?: boolean };
  /** False once the batch that opened this link has settled. */
  open: boolean;
  /** Taint the owning run (a derived run read untrusted content). */
  mark(): void;
}

const scope = new AsyncLocalStorage<RunTaintLink>();

/** Run `fn` with `link` as the taint of every tool call it makes. */
export function withRunTaint<T>(link: RunTaintLink, fn: () => T): T {
  return scope.run(link, fn);
}

/** The open taint link of the tool call this code runs inside, if any. */
export function activeRunTaint(): RunTaintLink | undefined {
  const link = scope.getStore();
  return link?.open ? link : undefined;
}

/** True when this code runs inside a tool call of a run that has read untrusted content. */
export function runIsTainted(): boolean {
  return activeRunTaint()?.state.untrustedSeen === true;
}
