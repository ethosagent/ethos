// Per-personality small-window mode — the resolver core's `setupTurn` asks
// once per turn (`LoopDeps.smallWindowResolver`, packages/core/src/agent-loop/
// small-window.ts).
//
// The startup decision in build-agent-loop.ts measures ONE personality in ONE
// directory. A `/personality` switch, a web or gateway turn for another
// personality, or a personality whose `fs_reach` workdir holds a different
// AGENTS.md all run a different static prefix, so the decision is re-made per
// (personality id, workdir, project-context fingerprint) — measured with the
// same `measureStaticFloor` arithmetic and the same file-context injector the
// startup decision uses, then memoized. The same floor sizes that
// personality's window-scaled tool-result budget (`resolveResultBudgetGate`,
// static-floor.ts), so a personality with a big prefix gets a smaller budget
// and the others keep theirs.
//
// What is NOT in the floor, by design: progressive sub-directory context
// layers. They are dynamic tail content (CLAUDE.md "prompt ordering is
// static-first, dynamic-tail"), discovered while the agent works and capped by
// `context_layering.cap_total_chars`. The per-turn compaction gate already
// counts them: `evaluateGate` (packages/core/src/agent-loop/compaction.ts)
// estimates `estimateTokens(systemPrompt)` over the WHOLE assembled prompt,
// progressive layers included, and prefers the provider's actual input tokens
// when it has them. `projectContextFor` measures the root layer only (it asks
// with no session, and progressive layers live per session).

import { createHash } from 'node:crypto';
import type { SmallWindowOverlay, SmallWindowResolver } from '@ethosagent/core';
import type { PersonalityConfig } from '@ethosagent/types';
import { resolveSmallWindowMode } from './model-catalog';
import {
  evaluateContextFit,
  type StaticFloorMeasurement,
  smallWindowModeMessage,
} from './static-floor';

export interface SmallWindowResolverOptions {
  /** The served context window, in tokens. */
  windowTokens: number;
  /** Model named in the fit diagnostic. */
  model: string;
  /** `compaction.smallWindow` from config; `on`/`off` decide for every
   *  personality, `auto` (default) applies the window and ratio triggers. */
  override?: 'auto' | 'on' | 'off';
  /** What small-window mode changes for a personality that engages it. */
  smallWindowOverlay: Pick<SmallWindowOverlay, 'promptBudget' | 'historyLimit'>;
  /** The personality's per-turn tool-result budget for its static floor
   *  (`resolveResultBudgetGate`, static-floor.ts, with its own
   *  `context_engine_options.resultBudgetChars`). */
  resultBudget: (
    personality: PersonalityConfig,
    staticFloorTokens: number,
  ) => { resultBudgetChars: number; maxSingleToolResultTokens?: number };
  /** The root project-context block for `personality` in a resolved `workdir`
   *  (`projectContextFor`, project-context-floor.ts). Called every turn; the
   *  file-context injector's mtime cache makes an unchanged file a stat, not a
   *  read. */
  projectContext: (personality: PersonalityConfig, workdir: string) => Promise<string>;
  /** The personality's static floor with `projectContextChars` of project
   *  context — SOUL, prelude and tool schemas measured the way the startup
   *  decision measures them (`measureStaticFloor`). Called only on a memo miss. */
  measureFloor: (
    personality: PersonalityConfig,
    projectContextChars: number,
  ) => Promise<StaticFloorMeasurement>;
  logger?: { warn(message: string): void };
  /** The startup personality, already measured and already announced by
   *  build-agent-loop.ts — seeded so its first turn neither re-measures nor
   *  repeats the warning. */
  seed?: {
    personality: PersonalityConfig;
    workdir: string;
    projectContext: string;
    floor: StaticFloorMeasurement;
  };
}

const fingerprint = (text: string): string => createHash('sha256').update(text).digest('hex');

/**
 * Build the per-turn window resolver: for each personality, whether
 * small-window mode is on and what tool-result budget its turns get, both
 * derived from THAT personality's static floor.
 *
 * Memoized per (personality id, workdir) holding the project-context
 * fingerprint it was measured against: an unchanged AGENTS.md reuses the
 * verdict without re-reading SOUL.md or re-serializing tool schemas, and a
 * changed one (new fingerprint) is re-measured and replaces the entry. SOUL.md
 * or toolset edits that leave the project context unchanged reuse the earlier
 * verdict until the process restarts — the same limitation
 * `createToolLoadingResolver` (static-floor.ts) documents for its key.
 *
 * Logs `smallWindowModeMessage` when a personality newly engages small-window
 * mode (once per engagement, not per turn), and the `evaluateContextFit`
 * diagnostic once per measurement whose prefix leaves no compactible room.
 * Pinned by packages/wiring/src/__tests__/small-window-resolver.test.ts.
 */
export function createSmallWindowResolver(opts: SmallWindowResolverOptions): SmallWindowResolver {
  const memo = new Map<string, { fingerprint: string; overlay: SmallWindowOverlay }>();
  const lastEngaged = new Map<string, boolean>();
  const keyOf = (personalityId: string, workdir: string) => `${personalityId}\u0000${workdir}`;

  const overlayFor = (personality: PersonalityConfig, floor: StaticFloorMeasurement) => {
    const smallWindow = resolveSmallWindowMode({
      contextWindow: opts.windowTokens,
      staticTokens: floor.tokens,
      ...(opts.override ? { override: opts.override } : {}),
    });
    const overlay: SmallWindowOverlay = {
      smallWindow,
      ...(smallWindow ? opts.smallWindowOverlay : {}),
      ...opts.resultBudget(personality, floor.tokens),
    };
    return overlay;
  };

  if (opts.seed) {
    const overlay = overlayFor(opts.seed.personality, opts.seed.floor);
    memo.set(keyOf(opts.seed.personality.id, opts.seed.workdir), {
      fingerprint: fingerprint(opts.seed.projectContext),
      overlay,
    });
    lastEngaged.set(opts.seed.personality.id, overlay.smallWindow);
  }

  // One measurement per (key, fingerprint) even when two turns for the same
  // personality start together (gateway lanes run concurrently).
  const inflight = new Map<string, Promise<SmallWindowOverlay>>();

  const measure = async (personality: PersonalityConfig, projectContextChars: number) => {
    const floor = await opts.measureFloor(personality, projectContextChars);
    const overlay = overlayFor(personality, floor);
    if (overlay.smallWindow && lastEngaged.get(personality.id) !== true) {
      opts.logger?.warn(
        smallWindowModeMessage({
          personalityId: personality.id,
          windowTokens: opts.windowTokens,
          floor,
          ...(opts.override ? { override: opts.override } : {}),
        }),
      );
    }
    lastEngaged.set(personality.id, overlay.smallWindow);
    const fit = evaluateContextFit({
      personalityId: personality.id,
      model: opts.model,
      windowTokens: opts.windowTokens,
      floor,
    });
    if (fit.message) opts.logger?.warn(fit.message);
    return overlay;
  };

  return async (personality, workdir) => {
    const projectContext = await opts.projectContext(personality, workdir);
    const key = keyOf(personality.id, workdir);
    const print = fingerprint(projectContext);
    const cached = memo.get(key);
    if (cached && cached.fingerprint === print) return cached.overlay;

    const flightKey = `${key}\u0000${print}`;
    let pending = inflight.get(flightKey);
    if (!pending) {
      pending = measure(personality, projectContext.length).finally(() =>
        inflight.delete(flightKey),
      );
      inflight.set(flightKey, pending);
    }
    const overlay = await pending;
    memo.set(key, { fingerprint: print, overlay });
    return overlay;
  };
}
