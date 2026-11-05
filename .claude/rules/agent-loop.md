---
paths:
  - "packages/core/src/**"
  - "packages/wiring/src/**"
  - "extensions/tools-kanban/**"
  - "extensions/gateway/src/index.ts"
---

# AgentLoop, hooks and single-owner contracts

AgentEvent types
AgentLoop.run() is an AsyncGenerator<AgentEvent>. Event types:

type AgentEvent =
  | { type: 'text_delta';     text: string }
  | { type: 'thinking_delta'; thinking: string }
  | { type: 'tool_start';     toolCallId: string; toolName: string; args: unknown }
  | { type: 'tool_progress';  toolName: string; message: string; percent?: number }
  | { type: 'tool_end';       toolCallId: string; toolName: string; ok: boolean; durationMs: number; error?: string }  // error set only when ok: false
  | { type: 'usage';          inputTokens: number; outputTokens: number; estimatedCostUsd: number }
  | { type: 'halt';           kind: 'budget' | 'watcher'; rule: string; toolName?: string; count?: number; message: string }  // early safety stop; a normal done still follows
  | { type: 'error';          error: string; code: string }
  | { type: 'done';           text: string; turnCount: number }
  | { type: 'decision';       id: string; phase: 'started' | 'settled'; site: 'injection' | 'approver' | 'router'; mode: 'on' | 'shadow'; personalityId: string; … }  // a decision site ran (decision-provider-personality §15.2); may arrive after done — web/desktop/CLI only, never a channel
Hook registry
Three execution models — pick based on what the hook does:

Model	Method	Semantics
Void	fireVoid	All handlers run in parallel via Promise.allSettled. Failures are swallowed (fail-open). Use for side effects: logging, analytics, notifications.
Modifying	fireModifying	Handlers run sequentially. Results are merged — first non-null value per key wins. Use when handlers need to amend the prompt or override args.
Claiming	fireClaiming	Handlers run sequentially. Stops at first { handled: true }. Use for routing decisions: which platform handles this message.
All three return () => void cleanup functions from register*().

before_ticket_complete (claiming) — fired by the kanban_complete tool before the running → done transition, with { taskId, summary, acceptanceCriteria? }. A handler returning { handled: true, reason } rejects the completion: the ticket goes to needs_revision (with reason in the audit trail) instead of done. Opt-in in standalone deployments — no handler registered (or no HookRegistry wired) means fireClaiming returns { handled: false } and completion proceeds unchanged. In team deployments (config `teamName` set), Phase 7 default-wires an eval-harness verifier handler (`createCompletionVerifier` in `@ethosagent/tools-kanban`, registered in `packages/wiring/src/compose-tools.ts`) that scores the summary against acceptanceCriteria in a separate LLM pass — fail-closed on verifier errors, and it does not skip on the assignee's autonomyTier. The original assignee can re-claim a needs_revision ticket and retry; the re-claim counts against the task's max_retries budget. `kanban_update_status` refuses `status: done` (`createKanbanUpdateStatus` and `SETTABLE_STATUS_VALUES` in extensions/tools-kanban/src/index.ts, pinned by the 'kanban_update_status refuses done' cases in `extensions/tools-kanban/src/__tests__/tools.test.ts`), so `kanban_complete` is the only agent path to done and the verifier cannot be bypassed (UBP-028).

Plugin host mode (`plugins.isolation: host`) runs each hosted plugin in its own child process, so a crash, hang or heap blow-up fails that plugin's call and never the loop. It is not a secrets boundary against malicious code: without `plugins.host.sandbox: auto` the child runs as the same uid and can read the vault files (D6). Enforcers: `PluginHostPool` (extensions/plugin-host/src/pool.ts: one process per plugin, --max-old-space-size), `HostCalls` (extensions/plugin-host/src/host-calls.ts: a crash or hang fails only that call; void hooks are fire-and-forget with a bounded FIFO queue) and extensions/plugin-host/src/proxies/modifying-hook.ts (overrideSystem dropped). Pins: extensions/plugin-host/src/__tests__/isolation-boundary.test.ts (expects the unsandboxed vault read to succeed, so a sandbox-by-default change must flip it on purpose) and crash-isolation.test.ts (crashes stay per-call).

Single-owner contracts (2026-09-12)
Four concerns had two owners each; the second owner is gone. Adding a third writer re-creates the bug the fix removed, so go through the owner:

| Concern | The one owner | What a second owner cost before |
|---|---|---|
| `providers.N.*` lines and quoted config scalars | `parseProviderChain` / `renderProviderChain` / `externalizeProviderChain` / `parseConfigScalar` / `quoteConfigScalar` in `packages/config`, used by the CLI writer AND `ConfigRepository` | any unrelated web save dropped a chain entry's `region`/`apiVersion`/`awsProfile` and every API-key reference |
| Which memory backend a surface reads and writes | `createMemoryBundle` → `CreateAgentLoopResult.memoryBundle`, injected into every host (`createWebApi` requires it) | under `memory: vault` the web editor, Timeline and restore wrote markdown the agent never read |
| Goal store + the executor that runs goals from it | `CreateAgentLoopResult.goals` (`{ store, executor }`), built together in wiring; `GoalsService` borrows the pair | desktop goals sat `running` forever with nothing executing them |
| Which adapter delivers a tracked send | `Gateway.adapterForBot(botKey, platform)` — every ledger-backed path (replies, sweep, `notifyTracked`, wakes, clarify notices) | with two bots on one platform, bot A delivered bot B's reply and A's success marked B's obligation delivered |
| How a model call outside a turn's own `streamStep` is recorded | `CreateAgentLoopResult.usageMeter` (`createUsageMeter`, packages/wiring/src/usage-meter.ts): `meter(provider, kind)`, `recordExternal(row)`, and its `recorder` passed as `AgentLoopConfig.usage`; pinned by `packages/wiring/src/__tests__/usage-no-double-count.test.ts` | a second meter, or a metered main `llm`, writes a ledger row beside the `messages` row for the same call: spend counted twice and the bot daily cap trips early |

Two lifecycle rules landed with them. A consumer of `AgentLoop.run()` must drain the iterator to exhaustion — `done` is the answer, not the end of the turn, and a `break` skips `runTurnComplete`, the turn-end memory flush and auto-compaction (deliver the answer at the terminal event, keep pulling, release the lane only when both are done; see `Gateway.runTurn` and `extensions/gateway/src/__tests__/turn-tail.test.ts`). And whatever assembles a runtime returns an idempotent `dispose()` registered beside construction (`DisposerStack` in `packages/wiring`): borrowers never dispose borrowed services, and a host closes only what it opened.

AgentLoop: before_tool_call hook must prevent execution, not just emit events
The hook fires before executeParallel. If you only emit tool_end ok:false but still add the tool to execInputs, the tool runs anyway. The correct pattern: check beforeResult.error → add to a rejected list → exclude from execInputs. Then persist an error tool_result for rejected tools so the LLM history stays consistent (Anthropic requires a tool_result block for every tool_use block in the preceding assistant message).

Anthropic API: every tool_use needs a matching tool_result
When the assistant message contains tool_use content blocks, the following user message must contain tool_result blocks for every one — including rejected or blocked tools. If a hook blocks a tool call, still persist a tool_result with is_error: true and the rejection reason. Missing tool_result blocks cause Anthropic API validation errors.

Prompt ordering is static-first, dynamic-tail — keep it that way
The system prompt is assembled STATIC-FIRST (injection-defense prelude → SOUL.md → priority-sorted injectors) with DYNAMIC sections at the TAIL (memory snapshot, progressive file-context, team topic index) — see `packages/core/src/agent-loop/stages/context-assembly.ts`. NO per-turn-varying text (dates, timestamps, turn counters) appears anywhere in the prompt. This is what keeps the static prefix byte-identical across turns so prefix caching works — Anthropic cache breakpoints, vLLM `--enable-prefix-caching`, and Ollama keep-alive all reuse the unchanged prefix. Any new injector MUST emit content that depends only on static inputs (personality, platform), or render per-turn/dynamic content as an `append` so it lands in the tail. Don't put a date/clock/counter in an injector. The regression guard is `packages/core/src/__tests__/prompt-prefix-stability.test.ts` — it drives two consecutive turns with unchanged memory and asserts a byte-identical static prefix; if you break the ordering it fails.

Local-serving note: to exploit the stable prefix, run vLLM with `--enable-prefix-caching` and rely on Ollama's keep-alive so the loaded prefix survives between turns.
