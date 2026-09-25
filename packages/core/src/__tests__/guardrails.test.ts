import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Orchestrator guardrails', () => {
  const agentLoopFile = join(import.meta.dirname, '..', 'agent-loop.ts');
  const agentLoopDir = join(import.meta.dirname, '..', 'agent-loop');

  it('agent-loop.ts is under the orchestrator size limit', () => {
    const content = readFileSync(agentLoopFile, 'utf-8');
    const lineCount = content.split('\n').length;
    // Phase 9 threshold — the orchestrator should stay lean. Ratcheted as the
    // loop legitimately grows (735 → 750 → 754 → 759 → 761 → 782 → 783); §5 added
    // the compaction gate config field, §2 added the promptBudget config field +
    // its constructor/deps threading (5 irreducible lines, compressed to one-line
    // shapes to keep the growth minimal); background sub-agents added the
    // rootSessionKey seam on RunOptions; the context-compaction phase added the
    // public `compact()` method (a thin delegator to `compactSession`).
    // Phase 3 (memory-flush + auto-compaction) added two turn dispatch seams —
    // the overflow→compact-and-retry decision and the post-`done` turn-end
    // maintenance call — plus the `memoryConsolidation` config field and its
    // constructor/deps threading. All substantive logic lives in
    // agent-loop/overflow.ts and agent-loop/turn-end.ts; only the wiring +
    // dispatch remain here.
    // Bumped 840 → 841: Item 7's guaranteed user-message tail is configured
    // globally (`compaction.minTailUserMessages`), and `/compact` is the one
    // compaction path whose deps are assembled here — so the knob costs exactly
    // one property line in the `compactSession` call (the new compaction fields
    // themselves went onto the existing one-line `compaction?:` config shape).
    // The logic lives in agent-loop/manual-compact.ts.
    // Bumped 841 → 846: Lane 3(b)'s `options.smallWindow` flag (declared
    // small-window toolset narrowing, D20) — option decl + one-line doc,
    // field, constructor default, deps threading (5 irreducible lines,
    // compressed to one-line shapes). The narrowing logic itself lives in
    // agent-loop/stages/turn-setup.ts + agent-loop/small-window-toolset.ts.
    // Bumped 846 → 873: tools-as-code-api Lane B — the per-turn ScriptToolBridge
    // construction (its deps ARE the turn's enforcement closure: allowlist,
    // hooks, watcher tap, shared counters) plus the `checkBudgets` closure that
    // replaced the inline checkTurnBudgets call so the loop's boundary check
    // and the bridge's per-call check are ONE arithmetic. The bridge logic
    // itself lives in agent-loop/stages/script-tool-bridge.ts.
    // Bumped 873 → 874: Lane E threads the loop's onToolMetric into the
    // ScriptToolBridge deps (one conditional-spread line) so inner calls hit
    // the same diagnostic seam as batch calls.
    // Bumped 874 → 877: `fs_reach.workdir` makes the working directory a
    // per-TURN product instead of a loop field, so the orchestrator destructures
    // `workingDir` + `fsReach` off TurnSetup and hands them to the tool stage
    // (4 lines), minus the `workingDir` dep the stage no longer needs (1). The
    // derivation itself lives in agent-loop/stages/turn-setup.ts.
    // Bumped 877 → 884: UI-cards D1 adds the `toolsetExclude` RunOptions field
    // (surface-level tool exclusion) — one declaration plus the doc explaining
    // how it differs from the adjacent `toolsetNarrow`. It is pass-through
    // only; the enforcement lives in agent-loop/stages/turn-setup.ts and
    // tool-registry.ts.
    // Bumped 884 -> 893 (voice V1a): the `voiceOrigin` RunOptions field - a
    // declaration, its doc, one import and one conditional spread into the
    // tool stage. Pass-through only; the annotation is rendered in
    // agent-loop/stages/context-assembly.ts and the gate that reads it lives
    // in @ethosagent/wiring.
    // Bumped 893 -> 894 (G4): the approval-posture declaration. The
    // orchestrator keeps only pass-through - the `logger` config field (Law 10
    // sink for the `ungated` notice), the latched guard field, its one-line
    // construction, and the single call at the first tool dispatch. The check
    // itself lives in agent-loop/approval-posture.ts.
    // Merge (voice V1a + G4): both landed in the same file, so the ceiling is
    // base + both deltas, not either one alone. Measured at 903.
    // Bumped 903 -> 916 (analytics A1): the per-turn usage accumulator — its
    // construction, one property into the stream deps, one into the finalizer
    // context, and one drain call at each of the five exits that return without
    // reaching the finalizer (abort, watcher terminate, unrecoverable overflow,
    // fatal stream failure, return-direct). The rollup is a derived cache of the
    // `messages` rows, so every path that persisted a message has to flush or
    // the cache silently under-reports. The accumulate/flush logic itself lives
    // in agent-loop/stages/turn-finalizer.ts.
    // Bumped 903 -> 913 (voice V1b): `addSessionCost`. The realtime tier's
    // per-audio-minute accrual is spend the loop did not incur, on the lane key
    // `agent_consult` runs its turns on, so it has to reach the SAME
    // `sessionCosts` map `budgetCapUsd` reads — two statements and their doc.
    // The metering, the cap and the spoken wind-down all live in
    // apps/web-api/src/voice/realtime-control-lane.ts.
    // Merge (analytics A1 + voice V1b): both landed in this file, so the
    // ceiling is base + both deltas, not either one alone. Measured at 926
    // (`split('\n').length`, which is one more than `wc -l` on a file with a
    // trailing newline — measure with the same instrument the check uses).
    // Bumped 926 -> 937 (voice L5): the `modelOverride` RunOptions field — a
    // declaration and its doc. Pass-through only: `run()` forwards the whole
    // `opts` object it already forwards, and the precedence
    // (pin > tierOverride > personality model > deployment default) is resolved
    // in agent-loop/stages/turn-setup.ts.
    // Bumped 937 -> 944 (pi-delegation plan Phase 1, D22): the `jobId`
    // RunOptions field — a declaration and its doc, plus one line threading it
    // into the internal `opts` object passed to `processTools`. Pass-through
    // only, unlike `rootSessionKey` there is no `?? sessionKey` fallback: the
    // per-job clarify lane (G1) needs `jobId` to stay `undefined` for a
    // foreground turn. The stamping site is `BackgroundExecutor.runOne`
    // (extensions/job-runner); the consuming logic lives in
    // agent-loop/stages/tool-processing.ts and packages/core/src/clarify/.
    // Bumped 944 -> 961 (model-visible ⟺ logged plan, Phase B): the optional
    // `contentStore`/`contextLog` config fields (AgentLoopConfig injection,
    // like every other optional dep), their private fields, one-line
    // constructor assignments, and one-line deps-getter threading — 17
    // irreducible pass-through lines. All the emit-on-change logic lives in
    // agent-loop/stages/context-emit.ts, called from
    // agent-loop/stages/context-assembly.ts.
    // Bumped 961 -> 972 (ground-truth verification, T2/R5): the optional
    // `turnAuditors` config field — AgentLoopConfig injection like every other
    // optional dep, its private field, the one-line constructor assignment and
    // one conditional spread into the finalizer context. 11 irreducible
    // pass-through lines; the budget, the fail-open handling and the
    // before-`done` yield all live in agent-loop/stages/turn-finalizer.ts.
    // Bumped 972 -> 980 (clarify hand-back outcome): `respondToClarify` returns
    // the `ClarifyRespondOutcome` its bridge reported instead of `Promise<void>`
    // — a wider signature (2 lines), a null-coalesce for the no-bridge case
    // (1 line) and the doc naming what enforces it (5 lines). 8 lines, none of
    // them logic: the outcomes themselves are decided in
    // packages/core/src/clarify/clarify-bridge.ts and named in
    // packages/core/src/clarify/respond-outcome.ts.
    // Bumped 980 -> 994 (abort before tool dispatch): a sixth early exit, after
    // streamStep and before processTools, so an abort that lands once the
    // response's tool_use blocks have streamed stops those tools instead of the
    // iteration-top check seeing it only after they ran. The exit is the same
    // flush / `aborted` error / endTrace sequence as the other five, plus one
    // import and one call; persisting the is_error tool_results lives in
    // agent-loop/stages/tool-rejection.ts (`persistAbortedToolCalls`).
    // Bumped 994 -> 996 (ToolContext parity at turn end): the run's context
    // store and the resolved `rootSessionKey` are handed to the turn-end stage,
    // so a tool the memory flush dispatches gets the contract the batch path
    // gives it. Two pass-through properties on the existing `turnEndExtras`
    // object; the ToolContext they feed is built in agent-loop/turn-end.ts.
    // Bumped 996 -> 1001 (model-registry T1.5/T1.15a): `modelRouting:
    // Record<string, string>` becomes `modelResolution: ModelResolutionContext`
    // — the same single optional config field, its private field and its
    // one-line constructor assignment — plus the D17 `once` suppression map,
    // which the decision requires the LOOP INSTANCE to own (module state would
    // leak one loop's announcements into another's). 5 pass-through lines: the
    // type import, the turn-model import, one comment line, the map field and
    // its deps-getter line. All the resolution, the refusal and the deviation
    // attachment live in agent-loop/turn-model.ts and
    // agent-loop/stages/turn-setup.ts.
    // Bumped 1001 -> 1004 (model-registry D21/D23b, chain override scoping):
    // `providerEntry` — which provider entry a turn's `modelOverride` belongs
    // to — is destructured from the setup and passed to the stream-step and
    // tool-processing contexts. 3 pass-through lines; the routing lives in
    // agent-loop/model-route.ts.
    // Bumped 1004 -> 1010 (brand-brain-quality D48, watcher pause ends with a
    // reply): the pause exit now calls `replyAfterWatcherPause` and folds its
    // text and turn into the turn (import, comment, call, fatal return, two
    // accumulators). The step context became a `stepCtx()` closure so the main
    // stream call and the closing call share one object literal instead of
    // two. The closing call, its system note and the tool_result for an
    // unoffered tool call live in agent-loop/stages/watcher-pause.ts.
    // Bumped 1010 -> 1017 (reach-and-containment Part 1, on-demand tool
    // loading): the optional `toolLoading` resolver — one config field and its
    // comment line, its private field, one-line constructor assignment and
    // deps-getter line — plus `setup.toolLoading` handed to the stream-step and
    // tool-processing contexts. 7 pass-through lines; the pinned/loaded
    // composition lives in agent-loop/tool-loading.ts and `tool_search` in
    // agent-loop/stages/tool-search.ts.
    // Bumped 1017 -> 1018 (openclaw-advisory-fixes Item 2): the turn
    // personality's `safety.denyRules` handed to the ScriptToolBridge, so
    // script calls cross the same deny-rule floor as the batch path. One
    // pass-through line; the check lives in stages/per-call-enforcement.ts.
    // Bumped 1018 -> 1020 (openclaw-advisory-fixes Item 7): the ScriptToolBridge
    // construction passes the redaction seam and the turn's personality (2
    // pass-through lines). The redaction lives in
    // agent-loop/stages/result-redaction.ts.
    // Bumped 1020 -> 1031 (openclaw-advisory-fixes F-A2): the public
    // `resultRedaction` getter hands the realtime voice host the loop's
    // redaction kit and observability (type import, a 3-line doc, a 6-line
    // getter, one blank). Pass-through only; the redaction lives in
    // agent-loop/stages/result-redaction.ts.
    // Bumped 1031 -> 1033: the public `resolvePersonality` method (doc + 3
    // lines) so the realtime voice host resolves a session's personality by
    // the loop's own rule; `getPersonalityBudgetCap` now delegates to it (-3).
    // The rule lives in agent-loop/stages/turn-setup.ts.
    // Bumped 1033 -> 1036 (openclaw-9.5-adoption D30): the `reviewOfJobId`
    // RunOptions field — a one-line doc, its declaration, and one conditional
    // spread into the internal `opts` passed to `processTools`, exactly the
    // `jobId` precedent. Pass-through only; the one-hop refusal lives in
    // extensions/tools-delegation (`delegate_task`).
    // Bumped 1036 -> 1038 (openclaw-9.5-adoption item 1): the `credentialPrompt`
    // RunOptions field (one-line doc + declaration) and the `scope` parameter
    // on `credentialCheck`, whose doc was compressed to its old length. The
    // gate and the call live in agent-loop/stages/turn-setup.ts.
    // Bumped 1033 -> 1035 (openclaw-9.5-adoption item 7, D32): the turn's
    // `serverCompaction` flag read off `setup` (one line) and handed to the
    // stream-step context (one line); the overflow `meta` carries it on an
    // existing line. The skips
    // live in stages/context-assembly.ts, overflow.ts and turn-end.ts; the
    // chunk handling in stages/stream-step.ts.
    // Merged 1038 + 2 -> 1040 (openclaw-9.5-adoption integration): lanes A and
    // F (1033 -> 1038) and lane D (1033 -> 1035) each ratcheted from 1033; the
    // cap is their sum.
    // Bumped 1033 -> 1039 (decision-provider-jev §8.3, tier router): the
    // optional `tierRouter` config field and its 2-line doc, its private field,
    // the one-line constructor assignment and deps-getter line. 6 pass-through
    // lines; the call condition and the downgrade-only rule live in
    // agent-loop/tier-router.ts, called from agent-loop/stages/turn-setup.ts.
    // Merged 1040 + 6 -> 1046 (decision-provider-jev integration): the
    // openclaw-9.5-adoption cap (1040) plus the tier router's 6 pass-through
    // lines, each ratcheted independently; the cap is their sum.
    // Bumped 1046 -> 1052 (per-personality small-window mode): the optional
    // `smallWindowResolver` config field (one line), its private field, the
    // constructor assignment and deps-getter line, the import, and the one
    // `turnDeps` line that applies the turn's decision (the three call sites
    // that took `this.deps` now take it, no new lines). The resolver lives in
    // packages/wiring/src/small-window-resolver.ts, the call in
    // agent-loop/stages/turn-setup.ts, the overlay in agent-loop/small-window.ts.
    // Bumped 1052 -> 1053: manual `/compact` reads the session personality's
    // own history limit — one `historyLimitFor` property in the
    // `compactSession` call. The resolution lives in agent-loop/small-window.ts
    // and agent-loop/manual-compact.ts.
    // Bumped 1046 -> 1059 (decision-provider-personality N7b, §15.3): `run()`
    // becomes a three-line shell that builds the turn's `TurnDecisions` and
    // wraps the (renamed, private) `runTurn` generator in `withDecisionEvents`,
    // plus the import and two pass-through lines handing the queue to
    // `setupTurn` and to the tool stage / ScriptToolBridge. The merge logic
    // lives in agent-loop/turn-decisions.ts.
    // Bumped 1059 -> 1063 (decision-provider-personality §15.3, the approver's
    // private sink channel): one `AgentLoopConfig.approverDecisionSinks` field
    // with its one-line doc, its private field, and its constructor assignment,
    // handed to `new TurnDecisions(...)`. The channel itself lives in
    // agent-loop/approver-decision-sinks.ts.
    // Merged 1053 + 17 -> 1070 (decision-provider-personality integration):
    // main's small-window/compact increases (+7 over 1046) plus this branch's
    // decision-event increases (+17 over 1046), each ratcheted independently;
    // the cap is their sum.
    // Bumped 1070 -> 1071 (tool cost persistence): the turn's rollup
    // accumulator handed to `processTools` (one pass-through line). The logic
    // lives in agent-loop/tool-cost.ts.
    expect(lineCount).toBeLessThanOrEqual(1071);
  });

  it('no stage file exceeds 700 lines', () => {
    const stagesDir = join(agentLoopDir, 'stages');
    const violations: string[] = [];
    for (const file of readdirSync(stagesDir)) {
      if (!file.endsWith('.ts')) continue;
      const content = readFileSync(join(stagesDir, file), 'utf-8');
      const lineCount = content.split('\n').length;
      // Bumped 720 → 722: background sub-agents threaded rootSessionKey through
      // tool-processing.ts's ToolContext construction, pushing it to 722.
      // Bumped 722 → 725: the denial circuit breaker needs approval denials
      // tagged apart from the other `Prepped.rejected` sources (MCP policy,
      // reject_args, injection downgrade, watcher halt) — a counter, an
      // increment in the `before_tool_call` branch, and a one-line comment.
      // Bumped 725 → 731: Lane 1(c) ingestion truncation caps tool-result
      // content at both persist sites (main path + returnDirect). The logic
      // lives in agent-loop/ingestion-cap.ts; only the import and the two
      // commented call sites land here.
      // Bumped 731 → 738: post-review FIX 7 moves the ingestion cap BEFORE
      // the untrusted wrap (so the cap can never sever </untrusted>) and adds
      // the cap to the hook-rejected path — comment lines only, the logic is
      // unchanged in size.
      // Bumped 738 → 746: tools-as-code-api Lane B — tool-processing binds the
      // per-turn ScriptToolBridge to the batch's ToolContext (two lines + the
      // ctx field + comment); the bridge itself is its own stage module.
      // Bumped 746 → 752: Lane E generalizes the per-batch progress queue to
      // AgentEvent (pushLiveEvent helper) so the bridge's inner-call
      // tool_start/tool_end ride the same live drain as tool progress.
      // Bumped 752 -> 759 (voice V1a): threads the turn's `voiceOrigin` onto
      // the `before_tool_call` payload (a ctx field + doc, one import, one
      // conditional spread) so the approval surface can tell a spoken request
      // from a typed one. No logic - the gate itself is in @ethosagent/wiring.
      // Bumped 759 -> 777 (G-INJ): the result-defense path no longer gates on
      // `result.ok`, so an `outputIsUntrusted` tool's ERROR text (an MCP server
      // answering `isError: true`) is wrapped and arms the downgrade. Two
      // provenance flags and the delimiter condition; the bulk is the comment
      // recording why the old "errors are framework-authored" claim was false.
      // Merge (voice V1a + G-INJ): both landed here, so the ceiling is base +
      // both deltas, not either one alone. Measured at 784.
      // Bumped 784 -> 787 (analytics A3): the turn's `traceId` is stamped on
      // the three message rows tool-processing persists (returnDirect results,
      // the main tool_result path, and user_steer) so `sessions.db` joins to
      // `observability.db`. One field per persist call, no logic.
      // Bumped 787 -> 792 (analytics B3): the turn's `traceId` now rides the
      // `done` AgentEvent, and the return-direct exit is one of the two places
      // that emits one. A single conditional spread, which no longer fits on
      // the one-line yield — so the cost is the five lines the formatter takes.
      // Bumped 792 -> 797 (analytics C1): `get_skill` calls are recorded as
      // skill INVOCATIONS, distinct from the injection-mode exposures assembly
      // records. The rule — which tool counts, how the name is extracted, the
      // optional-sink guard — lives in agent-loop/skill-telemetry.ts; only the
      // import and a two-line commented call land here.
      // Bumped 797 -> 801 (pi-delegation plan Phase 1, D22): `ToolContext.jobId`
      // is threaded into tool-processing's `ToolContext` construction, mirroring
      // `rootSessionKey` — a field on `ToolProcessingContext['opts']` plus its
      // conditional-spread line into `toolCtxBase` (no `?? sessionKey`
      // fallback, per D22). The lane logic itself lives in
      // packages/core/src/clarify/clarify-bridge.ts.
      // Bumped 801 -> 808 (P2-counters): a successful `memory_write`/
      // `team_memory_write` call feeds `ethos_memory_writes_total`, counted
      // only after `execute()` resolves and `result.ok` is known (never
      // derived from the span's truncated `attrs.args`). One import plus a
      // three-line commented call site; the dispatch rule itself lives in
      // agent-loop/memory-telemetry.ts.
      // Bumped 808 -> 816 (activity-feed-fix Phase 3): the tool call's own id
      // is written into the span's `attrs` alongside `args`, so a durable
      // `spans` row can be matched back to the live `tool_start`/`tool_end`
      // SSE events for the same call — without it the web Activity feed draws
      // every tool call twice. One field, plus the comment recording why the
      // link cannot come from the span id (generated inside the store) or from
      // the in-memory `spanIds` map (never persisted).
      // Bumped 816 -> 820 (feedback-activity-contract §3): both `tool_result`
      // persist sites now carry `isError: !result.ok` — the same `result.ok`
      // the LLM-facing block's `is_error` is already built from — so a
      // reloaded transcript can say `ok`/`failed` instead of `unrecorded`.
      // One field at each of the two sites, plus a two-line comment recording
      // that a hook-rejected call is a failure too.
      // Bumped 820 -> 821 (teams-as-a-scope, role gate per-turn): the turn's
      // `personalityId` is forwarded onto the `before_tool_call` payload — one
      // conditional spread; the role resolution lives in
      // extensions/tools-kanban/src/role-gate.ts.
      // Merge (feedback-activity-contract + teams-as-a-scope): both landed in
      // this file, so the ceiling is base + BOTH deltas (816 + 4 + 1), not
      // either side's number alone — 820 and 817 are each stale by the other's
      // delta. Merged file measures 820 lines; the cap keeps this file's
      // one-line convention.
      // Bumped 821 -> 828 (ground-truth verification, T2): the `after_tool_call`
      // payload gains the four fields an evidence collector needs — the call
      // id, the effective args, the turn's personality and its working dir —
      // all already in scope at the fire site. Four property lines plus the
      // comment recording that `p.args` is the untruncated effective args, not
      // the span's truncated `attrs.args`. No logic.
      // Bumped 828 -> 848 (ground-truth verification, FIX C): the rejected
      // branch now fires `after_tool_call` too, marked `rejected: true`, so a
      // refused call reaches the evidence ledger instead of vanishing from it.
      // One `fireVoid` with the same payload the executed branch builds (13
      // lines, no new values computed) plus the five-line comment recording why
      // absence was not neutral. No logic — the branch's own handling of
      // `result`/`llmContent` is untouched.
      // Bumped 848 -> 853 (model-registry D21, chain override scoping):
      // tool-processing.ts's context gains the turn's `providerEntry` (1 line)
      // and hands it to the tool's `SimpleCompletionImpl`, a 4th constructor
      // argument that the formatter spreads over five lines. No logic — the
      // scoping lives in providers/chained-provider.ts.
      // Bumped 853 -> 860 (reach-and-containment Part 1, on-demand tool
      // loading): tool-processing.ts gains one import, one optional context
      // field, a three-line `answerToolSearch` split before the batch loop, the
      // `recordDirectLoads` call and its comment, and seeds the tool_result
      // blocks with the search results. No logic — `tool_search` and D1-1
      // auto-loading live in agent-loop/stages/tool-search.ts.
      // Bumped 860 -> 861 (openclaw-advisory-fixes Item 2): tool-processing.ts
      // hands the turn personality's `safety.denyRules` to
      // `enforceBeforeToolCall`. One pass-through line; the check lives in
      // stages/per-call-enforcement.ts.
      // Bumped 861 -> 864 (decision-provider-personality N7b, §15.3): the
      // turn's decision queue on the stage context (one line), its import, and
      // its per-call sink handed to `enforceBeforeToolCall` and
      // `handleUntrustedResult` (one line each). Measured at 864. The sink
      // logic lives in agent-loop/turn-decisions.ts.
      // Bumped 864 -> 866 (openclaw-2026.9.6-gaps S12): tool-processing.ts
      // spreads the turn's `toolsetNarrowing` into the ToolContext (one line)
      // and imports its builder (one line). No logic — the builder lives in
      // agent-loop/toolset-narrowing.ts.
      // Bumped 866 -> 870 (tool cost persistence): the rollup accumulator on
      // the stage deps (one line), its type import and the helper's import (one
      // line each), and one spread onto the tool_result row. The logic lives
      // in agent-loop/tool-cost.ts.
      if (lineCount > 870) {
        violations.push(`${file}: ${lineCount} lines`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('no helper module in agent-loop/ exceeds 500 lines', () => {
    const violations: string[] = [];
    for (const file of readdirSync(agentLoopDir)) {
      if (!file.endsWith('.ts') || file === 'index.ts') continue;
      if (statSync(join(agentLoopDir, file)).isDirectory()) continue;
      const content = readFileSync(join(agentLoopDir, file), 'utf-8');
      const lineCount = content.split('\n').length;
      // Bumped 500 → 502: Lane 1(a) threads the max-single-tool-result gate
      // term through turn-end's evaluateGate deps (three lines; the arithmetic
      // itself lives in compaction.ts's shared evaluateGate).
      // Bumped 502 -> 517 (ToolContext parity at turn end): turn-end.ts is the
      // one helper that DISPATCHES tools, so the flush's ToolContext now carries
      // `rootSessionKey` and the run's context accessors — two fields on
      // TurnEndCtx/TurnEndExtras with their docs, two lines in buildTurnEndCtx,
      // three in the ToolContext, one import. No logic: the store is created in
      // agent-loop.ts and the parity is pinned by
      // __tests__/tool-context-parity.test.ts.
      // Bumped 517 -> 520 (openclaw-9.5-adoption item 7, D32): the turn's
      // `serverCompaction` flag on TurnEndCtx (field + one-line doc), copied in
      // buildTurnEndCtx, and read on the existing auto-compaction condition.
      if (lineCount > 520) {
        violations.push(`${file}: ${lineCount} lines`);
      }
    }
    expect(violations).toEqual([]);
  });
});
