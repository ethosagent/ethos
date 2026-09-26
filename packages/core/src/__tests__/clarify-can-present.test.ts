// `ClarifyBridge.canPresent` (plan reach-and-containment D4-5) — a read-only
// view of the predicate `request()` throws `ClarifyNoSurfaceError` on. The
// pairing is the whole contract: for every state below, `canPresent(x)` is
// true exactly when `request({ surfaceType: x })` does NOT throw that error.

import { InMemoryStorage } from '@ethosagent/storage-fs';
import type { ClarifySurfaceType } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { ClarifyBridge, ClarifyNoSurfaceError } from '../clarify/clarify-bridge';
import { FileClarifyStore } from '../clarify/file-clarify-store';

function makeBridge() {
  return new ClarifyBridge(new FileClarifyStore(new InMemoryStorage(), '/ethos/clarify'));
}

/** True when `request()` rejected with ClarifyNoSurfaceError. Aborts otherwise. */
async function requestThrowsNoSurface(
  bridge: ClarifyBridge,
  surfaceType: ClarifySurfaceType,
): Promise<boolean> {
  const abort = new AbortController();
  // The handler is attached synchronously so a rejection is never unhandled.
  const outcome = bridge
    .request({
      question: 'q',
      timeoutMs: 60_000,
      answerableBy: 'anyone',
      sessionId: `s-${surfaceType}-${Math.random()}`,
      surfaceType,
      abortSignal: abort.signal,
    })
    .then(
      () => false,
      (err: unknown) => err instanceof ClarifyNoSurfaceError,
    );
  // Give a presented request a tick to land, then cancel it.
  await new Promise((r) => setTimeout(r, 10));
  abort.abort();
  return outcome;
}

describe('ClarifyBridge.canPresent', () => {
  it('is false with no presenter, and request() throws ClarifyNoSurfaceError', async () => {
    const bridge = makeBridge();
    expect(bridge.canPresent('web')).toBe(false);
    expect(await requestThrowsNoSurface(bridge, 'web')).toBe(true);
  });

  it('is true once a presenter registers, and request() no longer throws it', async () => {
    const bridge = makeBridge();
    bridge.registerPresenter('web', () => {});
    expect(bridge.canPresent('web')).toBe(true);
    expect(await requestThrowsNoSurface(bridge, 'web')).toBe(false);
    // Another surface is unaffected.
    expect(bridge.canPresent('cli')).toBe(false);
    expect(await requestThrowsNoSurface(bridge, 'cli')).toBe(true);
  });

  it('turns false again when the presenter is released', async () => {
    const bridge = makeBridge();
    const release = bridge.registerPresenter('tui', () => {});
    release();
    expect(bridge.canPresent('tui')).toBe(false);
    expect(await requestThrowsNoSurface(bridge, 'tui')).toBe(true);
  });

  it('answers false for a platform string no surface type names', () => {
    expect(makeBridge().canPresent('cron')).toBe(false);
  });
});
