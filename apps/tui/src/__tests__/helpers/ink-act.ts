/**
 * React `act()` for the TUI's real-Ink tests. A test that writes a key right
 * after it sees a frame on stdout races React: the frame is written during the
 * commit, but a component's `useInput` subscription (and any state an event
 * handler set) lands afterwards, so a key written in between reaches whatever
 * was listening before — or a handler that still sees the old state — and is
 * lost. Wrapping each step that changes what renders in `act()` returns only
 * once the commit AND its passive effects are flushed.
 */

import type { PassThrough } from 'node:stream';
import { act } from 'react';
import { afterAll, beforeAll } from 'vitest';

export { act };

/** Tell React this file drives it with `act()`. Call once at the top level. */
export function enableReactActEnvironment(): void {
  const env = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  beforeAll(() => {
    env.IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterAll(() => {
    delete env.IS_REACT_ACT_ENVIRONMENT;
  });
}

/**
 * Write `data` to the fake stdin and flush what it causes. Ink reads stdin on
 * `readable` (next tick) and holds a lone Esc ~20ms in case it starts an
 * escape sequence, so the act scope stays open past both.
 */
export function pressKeys(stdin: PassThrough, data: string): Promise<void> {
  return act(async () => {
    stdin.write(data);
    await new Promise((r) => setTimeout(r, 50));
  });
}
