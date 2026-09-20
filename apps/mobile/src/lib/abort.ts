/** `AbortSignal.timeout(ms)` for runtimes that lack it — Hermes on RN 0.86 (R6b, R8). */
export function abortSignalTimeout(ms: number): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => controller.abort(new Error(`Timed out after ${ms} ms`)), ms);
  return controller.signal;
}
