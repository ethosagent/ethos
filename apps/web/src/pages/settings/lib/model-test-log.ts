// The page-session record of model tests: each row's last-test status and the 10s
// Test-button window (plan/phases/model-registry.md T2.8, D19).
//
// Module state rather than pane state, because a pane unmounts when you switch
// category (pane-context.ts) — and a window that reset on navigation would let
// the ordinary path reach the handler's `rate_limited` refusal, which D19 says
// it never should. It lives exactly as long as the tab. Nothing is persisted:
// stored health is T2.13's, not this.

import type { ModelRegistryTestResult } from '@ethosagent/web-contracts';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { TEST_COOLDOWN_MS } from './model-registry';

export interface ModelTestLog {
  /** Latest outcome per alias. */
  outcomes: Readonly<Record<string, ModelRegistryTestResult>>;
  /** When each test subject (`testSubjectKey`) was last tested, epoch ms. */
  testedAt: Readonly<Record<string, number>>;
}

/** The Test all button's own window. */
export const TEST_ALL_SUBJECT = 'all';

const EMPTY: ModelTestLog = { outcomes: {}, testedAt: {} };
let state: ModelTestLog = EMPTY;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot(): ModelTestLog {
  return state;
}

export function recordModelTest(input: {
  subjectKeys: readonly string[];
  testedAt: number;
  outcomes?: Readonly<Record<string, ModelRegistryTestResult>>;
}): void {
  const testedAt = { ...state.testedAt };
  for (const key of input.subjectKeys) testedAt[key] = input.testedAt;
  state = { outcomes: { ...state.outcomes, ...input.outcomes }, testedAt };
  for (const listener of listeners) listener();
}

/** Tests only — the log outlives a render tree by design. */
export function resetModelTestLog(): void {
  state = EMPTY;
  for (const listener of listeners) listener();
}

export function useModelTestLog(): ModelTestLog {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/**
 * `Date.now()` for this render, re-rendering twice a second while any window
 * in `testedAt` is still open so a `Test · 6s` label counts down, and not at
 * all otherwise.
 */
export function useCooldownClock(testedAt: Readonly<Record<string, number>>): number {
  const now = Date.now();
  const open = Object.values(testedAt).some((t) => now - t < TEST_COOLDOWN_MS);
  const [, tick] = useState(0);
  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(timer);
  }, [open]);
  return now;
}
