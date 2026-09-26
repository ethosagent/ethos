Ethos — AI Agent Codebase Guide
Behavioral guidelines
These rules apply to every task in this repo.

1. Think before coding
Don't assume. Don't hide confusion. Surface tradeoffs.

Before implementing:

State your assumptions explicitly. If uncertain, ask.
If multiple interpretations exist, present them — don't pick silently.
If a simpler approach exists, say so. Push back when warranted.
If something is unclear, stop. Name what's confusing. Ask.
2. Simplicity first
Minimum code that solves the problem. Nothing speculative.

No features beyond what was asked.
No abstractions for single-use code.
No "flexibility" or "configurability" that wasn't requested.
No error handling for impossible scenarios.
If you write 200 lines and it could be 50, rewrite it.
3. Surgical changes
Touch only what you must. Clean up only your own mess.

Don't "improve" adjacent code, comments, or formatting.
Don't refactor things that aren't broken.
Match existing style, even if you'd do it differently.
Remove imports/variables/functions that your changes made unused.
Every changed line should trace directly to the user's request.
4. Goal-driven execution
Define success criteria. Loop until verified.

"Add validation" → write tests for invalid inputs, then make them pass.
"Fix the bug" → write a test that reproduces it, then make it pass.
Always run pnpm check (typecheck + lint + test) before declaring done.
Always run pnpm lint before pushing. CI fails on lint errors; catching them locally is one command. If lint reports fixable issues, run pnpm lint:fix and re-check before git push. Don't push code that hasn't been linted.

5. Surface conflicts, don't average them
If two existing patterns in the codebase contradict, don't blend them. Pick one (the more recent or more tested), explain why, and flag the other for cleanup. Average code that satisfies both rules is the worst code.

6. Ask before adding to code you don't understand
"Looks orthogonal to me" is the most expensive phrase in this codebase. If you can't articulate why existing code is structured the way it is, ask before adding adjacent code.

7. Follow the constitution
[ARCHITECTURE.md](./ARCHITECTURE.md) is the structural source of truth for this codebase. It defines the layer model, dependency direction, frozen schemas, safety rules, and the laws the validator enforces. Read it before:

- Adding or moving any package, extension, or app.
- Adding a workspace dependency, especially one that crosses layers.
- Changing a contract interface under `packages/types/`.
- Touching any `safety-*` module.
- Modifying a frozen schema (personality, plugin contract, storage, agent event, etc.).
- Introducing raw `node:fs` calls in any module that participates in a personality boundary.
- Adding `console.*` calls in library code.

If your change conflicts with the constitution, either refactor to fit or open a constitutional amendment per [ARCHITECTURE.md §VI](./ARCHITECTURE.md). Do not introduce constitutional violations to land a feature faster — the cost compounds.

8. Git Safety
Never commit directly to main without explicit user confirmation. Never delete files or run destructive git operations (push, reset --hard, branch -D, checkout --, clean -f) without confirmation. When asked to "fix" or "clean up," stop and confirm scope before taking destructive actions. Approval for one destructive action is not approval for the next — confirm each time.

9. Plan vs Implementation
When the user asks to update, refine, or revise a plan document, ONLY edit the plan file — do not begin implementing the code changes described in the plan. Wait for an explicit "now implement" instruction before writing implementation code. The plan/ directory is gitignored — do not create worktrees for plan-only edits.

10. Verification Before Claims
Before reporting a phase or task as complete, re-verify by running `pnpm test && pnpm typecheck && pnpm lint`. When reviewing code from sub-agents, verify each claimed bug against the actual source before accepting or acting on it — sub-agent reviews have hallucinated bugs in the past. Do not claim "tests pass" or "lint clean" from memory; re-run.

11. Main session orchestrates; sub-agents execute
The main session does not write or edit files. Every code or doc change — even a one-line typo, a single-file rename, a single-language tweak — is delegated to a sub-agent via the Agent tool. The main session's job is: understand the request, draft a self-contained brief, review the result against the brief, report to the user.

- Applies to: Edit, Write, MultiEdit, and any Bash command that mutates the repository (git operations that change state, mv, rm, package installs, code generation that produces files).
- Does NOT apply to: read-only inspection (Read, Grep, Glob, `ls`/`cat`/`find`/`git status`/`git diff`/`git log` via Bash) and read-only verification (`pnpm test`, `pnpm typecheck`, `pnpm lint` — they do not mutate source).
- Exception: edits to AGENTS.md, CLAUDE.md, and other meta files that define agent operating rules may be made in the main session, since they govern the orchestration loop itself.

Why: the main session's context fills with conversation; sub-agents get clean, scoped context for the actual change. Mistakes contained to a sub-agent do not pollute the main session's understanding of the codebase.

12. Cite what enforces a guarantee
A comment or doc sentence asserting a guarantee — "X is refused", "Y is validated", "Z never happens" — names the file and symbol that enforces it, or the test that pins it. Add a line number only when the symbol alone would not find it, and expect it to drift.

This repo's most confident prose has described intent the adjacent code did not implement: a refusal attributed to an attestation nothing on the composition path reads, a fallback that actually failed closed, a duration grammar validated nowhere. Each read as fact for months. If you cannot name the enforcer, you have found a limitation — write it down as one. Do not add a linter for this.

What this is
Ethos is a TypeScript agent framework where personality is architecture. A personality (SOUL.md + toolset.yaml + config.yaml) is a structural component — not a system prompt string — that shapes tool access, memory filtering, model routing, and communication style simultaneously.

The CLI (ethos) gives you an interactive agent that persists sessions across restarts, loads built-in or custom personalities, and streams LLM responses with tool events.

Tech stack
Runtime	Node 24, TypeScript 6 strict
Dev runner	tsx (handles extensionless imports, no build step in dev)
Bundler	tsup (production builds only)
Package manager	pnpm workspaces
Lint / format	Biome 2 (single quotes, 2-space indent, 100-char line width)
Tests	vitest 4
LLM	@anthropic-ai/sdk, openai
SQLite	@ethosagent/sqlite (node:sqlite shim, WAL + FTS5)
Monorepo layout
packages/
  types/            @ethosagent/types     zero-dep interface contracts
  core/             @ethosagent/core      AgentLoop, ToolRegistry, HookRegistry, PluginRegistry

extensions/
  llm-anthropic/    @ethosagent/llm-anthropic       AnthropicProvider + AuthRotatingProvider
  llm-openai-compat/@ethosagent/llm-openai-compat   OpenAICompatProvider (OpenRouter/Ollama/Gemini)
  session-sqlite/   @ethosagent/session-sqlite      SQLiteSessionStore (WAL + FTS5)
  memory-markdown/  @ethosagent/memory-markdown     MarkdownFileMemoryProvider
  personalities/    @ethosagent/personalities       FilePersonalityRegistry + 5 built-ins

apps/
  ethos/            @ethosagent/cli       CLI entry point

plan/               Architecture notes, 29-phase roadmap (see PLAN.md), plus IMPROVEMENT.md tracking corrections
Path aliases in tsconfig.json point all @ethosagent/* imports to ./src/ source directly — no build step required in dev.

Core design principles
Interface contracts first — all extension points typed in @ethosagent/types. Core never imports concrete implementations.
Injection at construction — AgentLoop receives every component via AgentLoopConfig. Nothing reaches for globals.
No runtime deps in @ethosagent/types — zero imports, zero deps. Every package can import from it safely.
Extensionless TypeScript imports — import { X } from './foo' (no .js). tsx handles resolution in dev; tsup bundles for prod.
Key files
File	What it does
packages/types/src/index.ts	Barrel — every interface in the system lives here
packages/core/src/agent-loop.ts	The 12-step AsyncGenerator<AgentEvent> turn cycle
packages/core/src/tool-registry.ts	executeParallel() with per-call budget splitting
packages/core/src/hook-registry.ts	Void / Modifying / Claiming hook execution models
apps/ethos/src/wiring.ts	Assembles AgentLoop from ~/.ethos/config.yaml
apps/ethos/src/commands/chat.ts	Readline REPL — streaming output + slash commands
extensions/session-sqlite/src/index.ts	WAL + FTS5, rowid tie-breaking for ordered history
extensions/personalities/src/index.ts	mtime-cached personality loader, loadFromDirectory()
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

before_ticket_complete (claiming) — fired by the kanban_complete tool before the running → done transition, with { taskId, summary, acceptanceCriteria? }. A handler returning { handled: true, reason } rejects the completion: the ticket goes to needs_revision (with reason in the audit trail) instead of done. Opt-in in standalone deployments — no handler registered (or no HookRegistry wired) means fireClaiming returns { handled: false } and completion proceeds unchanged. In team deployments (config `teamName` set), Phase 7 default-wires an eval-harness verifier handler (`createCompletionVerifier` in `@ethosagent/tools-kanban`, registered in `packages/wiring/src/compose-tools.ts`) that scores the summary against acceptanceCriteria in a separate LLM pass — fail-closed on verifier errors, and it does not skip on the assignee's autonomyTier. The original assignee can re-claim a needs_revision ticket and retry; the re-claim counts against the task's max_retries budget.

Tool-progress audience boundary (Phase 30.2)
Tools call ctx.emit({ type: 'progress', toolName, message, audience? }) to surface progress. The audience field is the gate:

Default ('internal') — consumed by the framework only (logs, telemetry, dev TUI). Channel adapters (telegram, discord, slack, whatsapp, email) and apps/ethos/src/commands/chat.ts MUST NOT surface it.
'user' — explicit per-event opt-in by the tool author. Used for long-running operations where silent latency would be confusing (read_file reading >1MB, multi-step bash). The framework never opts in for the tool.
The same gate applies to the tool_progress AgentEvent. Surface code (CLI chat, channel adapters) renders only events with audience: 'user'.

Channel adapter contract
Every outbound channel message — including streaming finals and edits — flows through a single dedup path in the gateway: MessageDedupCache keyed by (sessionId, sha256(content)) with a 30s TTL. Adapters call adapter.send(); the gateway gates the call with cache.shouldSend(sessionId, content) and silently drops duplicates.

Adapters do NOT roll their own dedup. A new adapter does not need an idempotency layer. If you find adapter-local dedup logic, it's a bug. A new adapter MUST populate `InboundMessage.botKey` from the token/credentials it was constructed with. Use `deriveBotKey()` from `packages/core/src/bot-key.ts` (re-exported by `@ethosagent/core`, with a config-shaped wrapper in `packages/config/src/index.ts`) to derive a stable default when no explicit `id` is configured.
Configuration: GatewayConfig.outboundDedupTtlMs (default 30_000). Set to 0 to disable, or set the env var ETHOS_DEDUP_LEGACY=1 for the hard-off rollback hatch (one-release escape valve; remove in next minor).
Session boundaries: /new and /personality clear the previous session's dedup keys so the same response text can be sent again under the fresh session key.
See extensions/gateway/src/dedup.ts and the tests in extensions/gateway/src/__tests__/dedup.test.ts.

Dedup stops DOUBLE sends; the delivery ledger (`@ethosagent/delivery-ledger`, wired via `GatewayConfig.deliveryLedger`) stops LOST ones. Five reply paths — non-streaming final, errored/interrupted final, hook-claimed (`gateway_message`) reply, the streaming terminal edit, and a synthesized voice note — write a `pending` obligation BEFORE the platform call and mark it `delivered` only when `DeliveryResult.ok === true`. "Resolved without throwing" is NOT confirmation: every adapter catches platform failures and returns `{ok:false}`, so that definition would mark the exact failures the ledger exists to catch as delivered. `Gateway.sweepPendingDeliveries()` runs after `adapter.start()` in the gateway command and redelivers whatever is still `pending`, filtered to `botKey ∈ this.bots` and claimed atomically so peer processes sharing a ledger file each deliver an obligation exactly once. `Gateway.startDeliverySweep()`, armed right after it by `ethos gateway start` and `ethos boot`, repeats the sweep every `GatewayConfig.deliverySweepIntervalMs` (default 60s, 0 disables; stopped by `Gateway.shutdown`), so a reply a platform refused transiently is retried without a restart. A tick skips rows younger than `DELIVERY_SWEEP_MIN_AGE_MS`, because the live reply paths write `pending` before the platform call and do not claim, and a sweep never overlaps another (`deliverySweepInFlight`). Every sweep also skips a row whose live send is still running in THIS process, however long it takes (a flood-wait backoff, a large voice upload): `beginDelivery` registers the obligation id per ledger instance and `endDelivery` clears it in a `finally` around the platform call at every live site (`isDeliveryInFlight` in `extensions/gateway/src/delivery.ts`, pinned by the 'in flight' cases in `extensions/gateway/src/__tests__/delivery-ledger.test.ts`). Limitation: that registry is in-process, so a PEER process sharing the ledger file whose send outlasts the age grace can still be redelivered — `acquireGatewayLock` keeps that peer to an unusual deployment. Every sweep first returns `redelivering` claims older than `DELIVERY_CLAIM_STALE_MS` to `pending` (`DeliveryLedger.reclaimStaleClaims`, keyed on `claimed_at`, ledger schema v5), so a process that died mid-redelivery costs a retry, not the reply. Pinned by the 'periodic delivery sweep' cases in `extensions/gateway/src/__tests__/delivery-ledger.test.ts`. A refused redelivery is not retried on the next tick: `Gateway.settleRefusedRedelivery` counts it (`DeliveryLedger.deferRetry`, ledger schema v6 `attempts`/`next_attempt_at`) and the row is not due again for 1m, 2m, 4m … capped at 1h, ±20% jitter (`deliveryRetryDelayMs`); every sweep — the boot sweep and a restarted process included — skips a row before its `nextAttemptAt` (`sweepDeliveriesOnce`). At `GatewayConfig.deliveryMaxAttempts` refusals (default 10, ~4h) the row is `abandoned` with `abandon_reason` recorded (`DeliveryLedger.abandon`) and a `gateway.delivery_abandoned` event; a refusal the adapter marks `DeliveryResult.permanent` (Discord: HTTP 403/404 or an unknown-channel/missing-access code, `isPermanentDiscordError`; a voice row whose artifact is gone) is abandoned on the first attempt. Pinned by the 'redelivery backoff and cap' cases in the same file. Redelivery bypasses `shouldSend()` and calls `cache.record()` afterwards. Every obligation carries the `threadId` its reply belonged to (schema v2, nullable), so a redelivery returns to the sub-conversation rather than the root chat — the lane key already treats a thread as a distinct conversation, and on Slack or Telegram-with-topics a root-chat redelivery is the wrong place in front of the wrong audience-of-attention. A row with no thread redelivers with `threadId` undefined, never `''` or `'null'`. Delivery is at-least-once by design, and per-adapter honesty varies. Discord's chunked send reports `{ok:true}` once any chunk has landed, with `error: 'partial: N of M chunks …'`, so a sweep never re-posts the chunks that did arrive (`DiscordAdapter.send`, pinned by `extensions/platform-discord/src/__tests__/send-delivery.test.ts`). Telegram's does the same for text chunks and for a lead-text-plus-attachments send (`telegramPartial`), and marks every Bot API 403 and the chat-not-found / not-enough-rights 400s `permanent` (`isPermanentTelegramError`, pinned by `extensions/platform-telegram/src/__tests__/send-delivery.test.ts`); a chunk its plain-text parse fallback fails to post is still dropped silently. Slack's does the same for chunks and for a long answer whose lead posted before its reflow failed, and marks `channel_not_found`/`not_in_channel`/`is_archived`/`account_inactive` `permanent` (`isPermanentSlackError`, pinned by `extensions/platform-slack/src/__tests__/send-delivery.test.ts`). WhatsApp's reports a partial chunked send delivered the same way but marks nothing `permanent` — Baileys raises no error that distinguishes an unreachable chat (pinned by `extensions/platform-whatsapp/src/__tests__/send-delivery.test.ts`). A voice reply is `kind: 'voice'` (schema v3): `content` holds the spoken text, `artifactRef` names the synthesized audio in the gateway's `VoiceArtifactStore`, and redelivery re-sends THOSE bytes rather than re-synthesizing — a second TTS pass is a different recording. Confirming a voice obligation deletes its artifact; `Gateway.pruneVoiceArtifacts()` abandons undelivered ones past a cutoff and enforces a total-size cap with oldest-first eviction. The background-job wake notice is covered too (`Gateway.deliverCompletion` → `sendTracked`). Slash-command acks are deliberately NOT covered. Every ledger-backed send — the reply paths, the sweep, `notifyTracked`, the wake notice, the clarify notice — resolves its adapter by BOT (`Gateway.adapterForBot`), never by platform alone: two bots on one platform must never deliver each other's obligations, and a bot whose adapter is absent leaves its row `pending` rather than borrowing a sibling's (pinned by `extensions/gateway/src/__tests__/bot-addressed-delivery.test.ts`).

Dedup stops double turns, the delivery ledger stops lost replies, and the inbound spool (`@ethosagent/inbound-spool`, wired via `GatewayConfig.inboundSpool`, opened by the two commands that own platform adapters — `ethos gateway start` and `ethos boot` — through `openInboundSpool` in apps/ethos/src/lib/gateway-inbound-durability.ts; `ethos serve` never opens it) stops lost MESSAGES. `Gateway.acceptInbound` runs synchronously before any other work, in a fixed order: the in-memory dedup `Set`, then the spool row, and only then the durable dedup sighting (`inbound-dedup.db`). The two files cannot share a transaction, so the order is the guarantee: a crash between the two commits leaves a row that replay answers, and the platform's retry is dropped by the spool's own `UNIQUE (platform, bot_key, chat_id, message_id)` key — never a sighting with no row, which lost the message. A sighting the spool never recorded closes the fresh row and drops the message; a spool write that throws falls back to dedup alone (fail-open). Pinned by the 'dedup ordering' cases in `extensions/gateway/src/__tests__/inbound-spool.test.ts`. The inbound wiring (`wireAdapterInbound`, apps/ethos/src/commands/gateway.ts) calls it inside the adapter callback, so in webhook mode the row is on disk before the platform framework acks. Every non-turn path through `handleMessage` closes its row (a `handedOff` flag + `finally`). A turn's row is `processing` once its slot is held and `done` only after `runTurn` returns — the iterator drained AND the answer joined, never on the `done` event; a throw goes to `markFailed` (dead-lettered at `gateway.inboundSpool.maxAttempts`, default 3, and the lane then gets one tracked notice naming the row and `ethos gateway spool replay <id>` — `Gateway.notifyDeadLettered`, pinned by the 'poison message' cases in `extensions/gateway/src/__tests__/inbound-spool.test.ts`) and a shutdown abort refunds the attempt. A turn that has started a tool is NEVER replayed (plan openclaw-9.5-adoption D5): its first `tool_start` stamps `tool_started_at` (`Gateway.markSpoolToolStarted` → `markToolStarted`, spool schema v2), and replay, a failure or a shutdown then moves the row to `interrupted` and sends `INTERRUPTED_RETRY_NOTICE` through `notifyTracked`; only the user's exact `retry` within 24h re-runs it (`retryInterrupted`, a fresh row), and any other message in that lane discards it. A steer message folded into a running turn (`↩ noted`) shares that turn's fate (spool schema v3): `Gateway.linkAbsorbed` → `markAbsorbed` stores the turn's row id in `absorbed_into`, every terminal written to the primary is written to it in the same transaction (`cascadeAbsorbed` in `extensions/inbound-spool/src/index.ts`), `listReplayable` never lists it while its primary is owed, and the primary's replay and `retry` run it folded into the primary's text (`Gateway.foldAbsorbed`) — so a steer can never replay as a standalone turn and discard the interrupted row the user was told to `retry`. Pinned by the 'absorbed steer rows' cases in `extensions/gateway/src/__tests__/inbound-spool.test.ts` and `extensions/inbound-spool/src/__tests__/spool.test.ts`. The `retry` lookup runs before the clarify correlator so a dead question cannot swallow it, but acts only after the safety filter. `Gateway.shutdown` sends its "please resend" notice only to unspooled turns (D19): a spooled turn with no tool started is replayed on restart, one with a tool started gets the retry notice. Pinned by the 'a turn that started a tool' and 'shutdown notices' cases in `extensions/gateway/src/__tests__/inbound-spool.test.ts`; a replay may append the user message to the session a second time (D20, accepted — pinned in `turn-tail.test.ts`). A `delegate_task(background:true, deliver:'parent')` job (item 6) rides the same spool as a `wake_review` row: `Gateway.admitWakeReview` accepts the row (`wake:<jobId>`) BEFORE taking the job's delivery claim, then runs one review turn straight into `enqueueTurn` (no clarify correlator, no slash parsing) with `RunOptions.reviewOfJobId`, which `delegate_task` reads to refuse a second hop. An error, an empty answer, a tool-started crash, staleness or the attempt cap sends the plain wake notice instead, stamped `inboundRef` so the replay guard sees it — never lost, never both; pinned by `extensions/gateway/src/__tests__/parent-review.test.ts`. A review is as unprompted as the plain notice: inside quiet hours or a lane `/mute` (`Gateway.noticeHoldReason`, with a `heldNotices` store wired) `admitWakeReview` admits nothing and parks the job with its delivery claim untaken, `Gateway.releaseParkedReviews` (top of every delivery sweep) admits it once the hold ends, and a restart meanwhile re-owes it through `sweepUndeliveredJobs`; its plain-notice fallback is held like any notice (`sendReviewFallback` → `holdNotice`). Pinned by the U11 cases in the same file. CLI chat and web ignore `deliver`. Reply obligations carry `inboundRef` (delivery-ledger schema v4), and `Gateway.replayInboundSpool` — run after `adapter.start()` beside `sweepPendingDeliveries()`, then every 60s — skips any row the ledger already holds an obligation for (`hasObligationFor`), so a crash between reply and `markDone` does not answer twice. Replay is filtered to `botKey ∈ this.bots`, resolves the adapter with `adapterForBot` before the claim, re-enters `handleMessage` (safety filter included) one lane at a time in arrival order, and dead-letters rows older than 24h — checked BEFORE the adapter, so a row no adapter will serve cannot sit `deferred` forever — with one notice per lane that has an adapter. A message no replay could answer is never spooled (`Gateway.replayable`: its bot has no adapter on its platform) — every watcher wake and generic webhook route, which arrive with a per-request capturing adapter; pinned by the 'capturing adapters' cases in `extensions/gateway/src/__tests__/inbound-spool.test.ts`. Its orphan recovery is safe only because `acquireGatewayLock` (packages/wiring/src/gateway-lock.ts) guarantees one gateway per state dir; both adapter-owning commands take it first, before any store, via `takeGatewayLockOrExit` (same file as `openInboundSpool`), so a `gateway start` and a `boot` on one state dir exclude each other with exit 3 — pinned by `apps/ethos/src/__tests__/gateway-inbound-durability.test.ts`. Pinned by `extensions/gateway/src/__tests__/inbound-spool.test.ts` and the spool case in `turn-tail.test.ts`. The `gateway.spool_*` events, like every other `gateway.*` event, land in `observability.db`: `BuildGatewayOptions.observability` is a required field and both production hosts pass `gatewayObservability()` (apps/ethos/src/commands/gateway.ts — lazy per call, fail-open), pinned by `apps/ethos/src/__tests__/gateway-observability-wiring.test.ts`.

In multi-bot deployments, the gateway holds a `Map<botKey, AgentLoop>` — one loop per configured bot. The lane key is `${platform}:${botKey}:${chatId}` (not `${platform}:${chatId}` as in single-bot mode). Every adapter stamps `InboundMessage.botKey` so the gateway can route to the right loop. Adapters that do not support `botKey` (Discord, Email) fall back to the `defaultBotKey` in single-bot deployments; in multi-bot deployments their messages are dropped with an observability event. The per-bot botKey must be stable across restarts — use the optional `id:` field in config, or accept the sha256-derived default.

Storage abstraction
All filesystem reads and writes under ~/.ethos/ go through the Storage interface from @ethosagent/types. New code must NOT import from node:fs/promises (or node:fs) for ~/.ethos/ access — wire a Storage in via the constructor.

Implementation	Where it lives	When to use
FsStorage	@ethosagent/storage-fs	Production wiring (CLI, web-api, gateway)
InMemoryStorage	@ethosagent/storage-fs	Tests — populate fixtures via write(), no tmpdir scaffolding
ScopedStorage	@ethosagent/storage-fs	Decorator — enforces a per-personality read/write path allowlist
Allowed exceptions (these stay raw node:fs):

extensions/session-sqlite/, extensions/memory-vector/ — SQLite via @ethosagent/sqlite opens raw paths and manages WAL/SHM natively
extensions/job-store/ — SQLiteJobStore opens a raw path via @ethosagent/sqlite and mkdirSync's the db's parent dir (same rationale as session-sqlite/memory-vector)
extensions/delivery-ledger/ — SQLiteDeliveryLedger opens a raw path via @ethosagent/sqlite and mkdirSync's the db's parent dir; its atomic redelivery claim is a conditional UPDATE inside a transaction, which no Storage interface can express
extensions/session-cards/ — SQLiteCardStore opens a raw path via @ethosagent/sqlite and mkdirSync's the db's parent dir; its per-session `seq` derivation is a MAX()+1 read inside the insert's transaction, which no Storage interface can express (same rationale as job-store/delivery-ledger)
extensions/call-log/ — SQLiteCallLog opens a raw path via @ethosagent/sqlite and mkdirSync's the db's parent dir (same rationale as job-store/delivery-ledger/session-cards)
extensions/inbound-dedup/ — SQLiteInboundDedupStore opens a raw path via @ethosagent/sqlite and mkdirSync's the db's parent dir; its check-and-record is a single `INSERT OR IGNORE` whose affected-row count IS the answer, which no Storage interface can express (same rationale as job-store/delivery-ledger/session-cards/call-log)
extensions/inbound-spool/ — SQLiteInboundSpool opens a raw path via @ethosagent/sqlite and mkdirSync's the db's parent dir; its replay claim is a conditional UPDATE inside a transaction, which no Storage interface can express (same rationale as delivery-ledger/notify-queue)
extensions/channel-transcript-sqlite/ — SQLiteChannelTranscriptStore opens a raw path via @ethosagent/sqlite and mkdirSync's the db's parent dir; `pruneChannelTranscript` additionally existsSync's the db file so a prune on a deployment that never enabled observe mode is a no-op rather than a call that CREATES an empty database on every machine (same rationale as job-store/delivery-ledger/session-cards/call-log/inbound-dedup)
packages/a2a/src/sqlite-task-store.ts — SQLiteA2aTaskStore opens a raw path via @ethosagent/sqlite and mkdirSync's the db's parent dir (same rationale as job-store/delivery-ledger/session-cards/call-log); the A2A async task store, so a task's terminal state and idempotency key survive an `ethos serve` restart
extensions/agent-mesh/src/index.ts acquireRegistryLock — mkdirSync/writeFileSync/statSync/unlinkSync for an advisory `wx`-flag sentinel file guarding the mesh registry.json write; the registry CONTENT itself already goes through the injected Storage (plan a2a-spec-compat T1.1 / D12 — confirmed the only raw `node:fs` in this module). A lock is a primitive Storage cannot express, same category as delivery-ledger's atomic claim
extensions/notify-queue/ — SQLiteNotifyQueue opens a raw path via @ethosagent/sqlite and mkdirSync's the db's parent dir; its `readAndConsume` is a SELECT then UPDATE inside one transaction, the same shape as delivery-ledger's atomic claim, which no Storage interface can express (same rationale as job-store/delivery-ledger/session-cards/call-log)
extensions/outbox/ — SQLiteOutboxStore opens a raw path via @ethosagent/sqlite and mkdirSync's the db's parent dir; the bound approve and the delivery claim are conditional UPDATEs whose affected-row count IS the answer, which no Storage interface can express — same rationale as delivery-ledger/notify-queue
apps/ethos/src/error-log.ts — sync crash logger; must flush before process exit
apps/ethos/tsup.config.ts and other build-time tooling
extensions/skills/src/skill-compat.ts statSync — walks $PATH, not ~/.ethos/
extensions/gateway/src/media.ts lstatSync — symlink-refusal on an arbitrary tool-produced outbound-media path (W3.2 exfiltration guard), not ~/.ethos/; Storage follows symlinks
extensions/gateway/src/transcode.ts — ffmpeg transcodes FILES, not buffers, so the stage materializes scratch input/output paths under os.tmpdir() and unlinks them in a finally. Never ~/.ethos/: the synthesized artifact that IS persisted goes through Storage via `VoiceArtifactStore`. Same carve-out extensions/voice-providers/'s command-tts already has, for the same reason
extensions/plugin-loader/src/tarball-pin.ts mkdtemp/readdir/rm (and `computeIntegrity`'s readFile in lockfile.ts) — FU-1's verified plugin install. `npm pack` writes the pinned `package@version` tarball as a FILE, so `withPackedTarball` creates a scratch directory under os.tmpdir(), finds the one `.tgz` npm wrote there, hashes it, and removes the directory in a finally; on a match that same file path is what `npm install --ignore-scripts` receives, so the bytes checked are the bytes installed. Never ~/.ethos/: the pin itself is read and written through Storage (`readLockfile`/`writeLockfile`), and Storage has no way to name a path an external binary writes into. Same scratch-file rationale as extensions/gateway/src/transcode.ts. `extensions/plugin-loader/` was already on the `no-raw-fs.test.ts` prefix allowlist; this line records the reason for this use rather than widening the scan
extensions/gateway/src/channel-digest-lock.ts mkdirSync/writeFileSync/readFileSync/statSync/unlinkSync — the ambient channel digest's cross-process run sentinel, `~/.ethos/channel-digest.lock`: an advisory `wx`-flag exclusive create held for the whole of one digest run, with stale detection by the holder's pid. The digest reads every lane's cursor out of one JSON file, spends a paid LLM pass and a delivery per lane, then writes the whole map back — `Storage.writeAtomic` keeps that file from being torn but provides NO isolation, so two gateways sharing one `~/.ethos` both digest the same watched rooms, deliver the same summary to the same owner twice, and let the later write erase what the earlier advanced. The same primitive and the same carve-out as `extensions/agent-mesh/src/index.ts`'s registry lock and `packages/wiring/src/backup-schedule.ts`'s `backups/.lock`: `exists()` then `write()` is the exact race the lock exists to close, and no Storage interface can express an atomic create-if-absent. Copied rather than imported — `packages/wiring` sits ABOVE `extensions/` in the layer model, so `acquireBackupLock` is not reachable from here, and agent-mesh's version blocks where this one must skip. A contended run does NOT wait: it returns `skippedReason` on the report (printed by `summarizeChannelDigest` into the cron run-output file) and records a `channel.digest_skipped` observability event, because whatever it would have read the holder is reading right now and the ingestion cursor leaves the remainder for the next tick. Nothing else on the digest path takes this carve-out — the cursor file itself still goes through Storage
extensions/tools-code/src/shim/js-shim.ts — textual false positive: the `node:fs` import lives inside a String.raw literal (the container-side shim client source delivered at exec time, tools-as-code-api Lane A); the module itself performs no host filesystem access
apps/web-api/src/services/documents.service.ts lstat — symlink-refusal on the operator-supplied Documents path; same rationale as gateway/media.ts. ScopedStorage confines the path, but Storage follows symlinks and has no lstat, so a symlink inside the workdir resolves outside it while passing the prefix test on the link path. Every path segment is lstat'd, not just the leaf, because a symlinked PARENT escapes with a non-symlink leaf
apps/web-api/src/routes/documents.ts createReadStream — the download route streams bytes; Storage.readBytes would buffer a whole artifact into the server heap
extensions/platform-callcapture/src/detector.ts existsSync — checks whether the compiled `mic-detector` CoreAudio helper binary (native/bin/, gitignored build artifact shipped alongside the package) exists, so a missing build throws a clear "run this command" error instead of a bare ENOENT. Not a ~/.ethos/ operation, same rationale as skills/skill-compat.ts
extensions/platform-callcapture/src/audio-process.ts existsSync — same rationale as detector.ts above, generalized to Phase 3's two native capture binaries (the vendored `audiotee`, native/vendor/, and the compiled `mic-capture`, native/bin/): a missing build throws a clear "run this command" error instead of a bare ENOENT before spawning either one. Not a ~/.ethos/ operation
extensions/platform-callcapture/src/preflight.ts existsSync — Phase 4's combined dependency preflight (`checkCallCaptureDependencies`, T5), checking presence of the same three native binaries detector.ts/audio-process.ts check individually, before a notification or capture attempt starts. Same rationale: not a ~/.ethos/ operation, names the exact missing binary and its build/fetch command rather than a bare ENOENT
extensions/platform-callcapture/src/ownership.ts openSync/closeSync/readFileSync/unlinkSync/writeFileSync — `tryClaimOwnership`'s cross-process PID-claim lock so `ethos serve` and `ethos gateway` never both run a live `CallCaptureDaemon` at once. Same carve-out category as `extensions/team-supervisor/src/pid.ts`'s `acquirePidFile` (process-management state, not ~/.ethos/ personality data); an atomic exclusive-create + liveness-check + stale-cleanup lock has no equivalent in the Storage interface
extensions/platform-callcapture/src/indicator.ts existsSync — same rationale as detector.ts above: checks whether the compiled `capture-indicator` AppKit helper binary (native/bin/, gitignored build artifact) exists before spawning it, so a missing build throws a clear "run this command" error instead of a bare ENOENT. Not a ~/.ethos/ operation
extensions/execution-pi/src/worktree.ts mkdirSync/existsSync — creating a Pi run's workspace IS a `git worktree add`: the git binary writes a whole tree, which no Storage method can express, and the surrounding mkdir/exists checks are that same operation's bookkeeping. Same category as the SQLite stores' mkdirSync of a database's parent dir
extensions/execution-pi/src/availability.ts existsSync — answers "is this machine set up to run Pi at all" against the operator's Pi credential file (`auth.json`), which is never opened and never read; the container receives it as a read-only mount. Same rationale as platform-callcapture/src/detector.ts's binary-presence check, and not a ~/.ethos/ operation
extensions/execution-coding-agents/src/worktree.ts mkdirSync/existsSync — same rationale as execution-pi/src/worktree.ts above, copied not imported (D-ACP1: no shared file between the two packages): creating a real ACP-native agent's run workspace IS a `git worktree add`, and the surrounding mkdir/exists checks are that same operation's bookkeeping. `extensions/execution-coding-agents/src/availability.ts` needs no such exception — it probes readiness with `spawn` only and has no `node:fs` import at all
extensions/execution-ssh/src/index.ts accessSync — a pre-flight writability probe on the effective known-hosts destination, run before an `accept-new` ssh connection is spawned. `StrictHostKeyChecking=accept-new` means "learn the key on first sight, refuse it if it ever changes", and the second clause is bought entirely by the learned key being PERSISTED; OpenSSH warns and CONTINUES when it cannot record one (verified 9.6p1 against a real sshd: `Failed to add the host to the list of known hosts (…)`, remote command ran, exit 0), so every later connection is a first connection again — silent MITM exposure while the config claims pinning. The path is OPERATOR-supplied, resolved the way ssh itself resolves it: `execution.ssh.knownHostsFile` when set (Ethos passes it as a command-line `-o`, which outranks the config file), otherwise the first entry of the `userknownhostsfile` line in `ssh -G` output for that destination (`knownHostsFromSshConfig`), which honours the operator's `~/.ssh/config` including `Include` and `Match` blocks and so can name a path neither Ethos nor the operator typed here. `~/.ssh/known_hosts` (`DEFAULT_KNOWN_HOSTS`) is only the fail-open fallback for when `-G` yields nothing this process can read — no ssh binary, non-zero status, timeout, or no `userknownhostsfile` line. A MULTI-ENTRY value is not a fail-open case: `-G` separates entries with whitespace and prints a space-containing path raw (verified 9.6p1 — it strips the quoting the config file gave it), so the value is read as a list, its first entry is probed, and the refusal names the whole resolved value alongside the entry probed rather than a fragment. The `-G` subprocess is asynchronous (`spawn`, not `spawnSync`): it evaluates the operator's `Match exec` blocks and reads a config file that can live on a slow filesystem, and blocking the event loop for that would stall every bot and lane in the process. Whichever path that resolution names lives outside `~/.ethos/`, and is read by the ssh binary and never by Ethos: nothing is opened, nothing is parsed, no personality data passes through it. `Storage` could not express the check even if the path were in scope, because it has no writability probe — `exists()` answers a different question (the file legitimately does not exist yet; accept-new creates it), and the only way to ask `Storage` whether a write would succeed is to PERFORM one, which would mean Ethos writing into the operator's known_hosts to find out whether ssh could. Same category as `extensions/platform-callcapture/src/detector.ts`'s binary-presence `existsSync` and `apps/web-api/src/services/documents.service.ts`'s `lstat`: a fact about the host filesystem the storage contract does not model. Deliberately NOT duplicated into `packages/config` the way the LEXICAL known-hosts check is — that one refuses a value, which is as true at boot as it ever will be; this one reads the filesystem, which a `chmod`, a mount, or a container's first run can change under a process that is already up
packages/core/src/scoped/scoped-fs.ts lstatSync/readlinkSync — symbolic containment for `fs_reach` (gap G11). This IS the boundary check, so it cannot route through the thing it guards: Storage follows symlinks and has no lstat, which is exactly why the previous lexical-only prefix match let a symlink planted inside an allowed prefix resolve outside it. Walks every segment below the matched prefix, not just the leaf, because a symlinked PARENT escapes with a non-symlink leaf. Deliberately synchronous — async would force the whole ScopedFs contract open for no security gain
packages/storage-fs/src/scoped-storage.ts lstatSync/readlinkSync — the same check on the Storage side. Already inside the storage-fs prefix carve-out ("it IS the fs adapter"), but called out here because the two implementations are duplicated on purpose — core cannot import storage-fs at runtime (kernel layer boundary, ARCHITECTURE.md §II) — and they MUST change together. Each file carries a pointer to the other
packages/wiring/src/backup/ createReadStream/createWriteStream/statSync/readdirSync/existsSync/mkdirSync/mkdtempSync/renameSync/rmSync/writeFileSync/unlinkSync/openSync/writeSync/fsyncSync/closeSync/readFileSync/lstatSync/readlinkSync — the backup archive format and the engine on top of it (plan `agent-state-backup.md` D1–D4). Archive I/O is stream I/O over arbitrarily large files: `TarWriter` copies a `state` snapshot into a gzip stream 64 KiB at a time and the reader hands each entry's body back as an async iterable, so neither side ever holds a whole file — `Storage.read`/`readBytes` return a fully buffered string or `Uint8Array`, which is the failure this module exists to fix (the tar it replaces `Buffer.concat`s the entire archive). `tar.ts` is exactly three calls: `createReadStream` for a source file and for the archive being read, `createWriteStream` for the archive being written, and `statSync` for the byte size a ustar header must declare before the first byte is read. The engine adds four more, each one an operation Storage has no method for: `readdirSync` WITH DIRENTS in `scopes.ts` (the walk must refuse a symlink before reading it — a link inside `~/.ethos/` would otherwise let an archive carry a file from anywhere on the machine under an innocent name, and `Storage.listEntries` reports `isDir` but not `isSymbolicLink`), `mkdtempSync`/`rmSync` in `create.ts` for the staging tree database snapshots are written into and for the partial archive's own directory inside the DESTINATION directory (an archive is renamed onto `outPath` only once it is complete, so a failed run cannot truncate the previous good backup; same directory means the finish is a `renameSync`, not a copy), `mkdtempSync` again in `restore.ts` because the `.pre-restore/<timestamp>-<unique>/` displacement directory's uniqueness has to come from an atomic create — a second-resolution timestamp collides between two restores in the same second and the later one renames its recovery copies over the earlier one's, `rmSync` in `restore.ts` for its own `.pre-restore/<timestamp>-<unique>-staging/` tree and for undoing a half-finished install, and `renameSync` in `restore.ts` for the displacement and for moving each staged file into place — a MOVE, which `Storage` cannot express without reading the whole file back through the heap, defeating the point of streaming it. `mkdirSync`/`existsSync` are those same operations' bookkeeping. `writeFileSync`/`unlinkSync` in `restore.ts` are the `.restore-in-progress` sentinel: an advisory `wx`-flag exclusive create held for the duration of a restore, with stale detection by mtime, the same primitive and the same carve-out as `extensions/agent-mesh/src/index.ts`'s registry lock — a lock is not something the `Storage` interface can express. `openSync`/`writeSync`/`fsyncSync`/`closeSync`/`readFileSync` in `restore.ts` are the install phase's write-ahead journal, `journal.jsonl` inside the `.pre-restore/<timestamp>-<unique>/` directory whose recovery copies it describes: each rename is recorded and the descriptor `fsync`ed BEFORE the rename happens, so a `SIGKILL`, an OOM kill or a power cut cannot leave a moved file nothing knows about, and the next restore to take a stale sentinel over rolls the dead one back from it (`readdirSync` finds it, `unlinkSync` clears it). The durability ORDER is the whole point, which is why this is a held descriptor with an explicit `fsync` per record rather than `Storage.writeAtomic` — an atomic whole-file replace gives a file that is never torn, not a record that is on the platter before the operation it protects, and `Storage` has no way to say `fsync`. `restore.ts` additionally opens live databases through `@ethosagent/sqlite` on a raw path for the D4 lock gate (`PRAGMA locking_mode = EXCLUSIVE` + `BEGIN IMMEDIATE`), which holds the LIVE file's inode and therefore does NOT cover the replacement a rename installs under that name (databases are installed last to keep that window short), and `snapshot.ts` for `backup()`/`VACUUM INTO` — the same carve-out every SQLite store has, for the same reason: the shim opens files, and a consistency lock is a primitive no `Storage` interface has. Nothing here interprets or filters personality data; path safety is enforced on the archive's own entry names (`assertSafeEntryPath`) and on the scope table (`classifyPath`, which re-runs on the way IN so an archive carrying `secrets/` or `keys.json` is refused), not on the filesystem. `lstatSync`/`readlinkSync` in `restore.ts` are the exception to that last clause and the reason they are listed here: an entry name that passes both guards still resolves through this machine's symbolic links, so every destination the restore writes to, moves, or moves onto is walked segment by segment BELOW `dataDir` — leaf-only is not enough, a symlinked PARENT escapes behind an ordinary leaf — and refused if it lands outside. `Storage` follows symlinks and has no `lstat`, which is exactly why `packages/core/src/scoped/scoped-fs.ts` and `packages/storage-fs/src/scoped-storage.ts` already carry this same check twice; this is the third copy, for the same reason (`packages/wiring` cannot import either at runtime) and it must change with them
packages/wiring/src/backup/sentinel-lock.ts mkdirSync/writeFileSync/readFileSync/statSync/unlinkSync — `acquireSentinelLock`, the ONE advisory `wx`-flag exclusive-create lock in `packages/wiring`, with exactly three callers: `acquireBackupLock` (`packages/wiring/src/backup-schedule.ts`, `backups/.lock`), `acquireIdentityMapLock` (`packages/wiring/src/identity-map.ts`, `users/identity-map.json.lock`) and `acquireGatewayLock` (`packages/wiring/src/gateway-lock.ts`, `gateway.lock`). `inspectSentinelLock` in the same file reads a lock without taking it, classifying the holder by the acquire's own stale rule, for `ethos gateway status`. The protocol: `wx` create, then confirm the file still carries this call's random `token`; on EEXIST classify the incumbent with `classifyHolder`/`currentBootId` (imported from `backup/holder-identity.ts`, not copied) and unlink it only if stale AND byte-identical to what was read; mtime-based staleness only when the body carries no readable pid; `release` deletes only its own bytes. Each caller passes its own wait bound (`timeoutMs`, `0` = one attempt then refuse), poll interval, unreadable-body stale window and refusal text. The same primitive and the same carve-out as `extensions/agent-mesh/src/index.ts`'s registry lock — `exists()` then `write()` is the exact race the lock exists to close, and no `Storage` interface can express an atomic create-if-absent. It is shared, not copied, inside this package because nothing in the layer model stops these callers from importing it; the agent-mesh and channel-digest copies stay separate on purpose, because `extensions/` cannot import `packages/wiring`. `backup/restore.ts`'s `.restore-in-progress` sentinel is a different protocol (write-ahead journal, mtime-only staleness) and does not use it
packages/wiring/src/backup-schedule.ts — no raw `node:fs` of its own. The scheduled backup's `backups/.lock` sentinel (held for the duration of a run so a manual `ethos backup` and the cron job cannot stream the same databases into two archives at once) is `acquireBackupLock`, a caller of `acquireSentinelLock` in `packages/wiring/src/backup/sentinel-lock.ts`, which holds the `node:fs` calls; this file supplies only the lock's own settings (5s default wait, 100ms poll, one-hour clock for a body with no readable pid) and its refusal text. Rotation, which deletes archives, deliberately does NOT take any carve-out: it goes through `Storage.listEntries`/`remove` like ordinary code
packages/wiring/src/gateway-lock.ts — no raw `node:fs` of its own. `acquireGatewayLock`'s `<ethosDir>/gateway.lock` is the gateway singleton lock (plan reach-and-containment §2.7): taken by `ethos gateway start` and `ethos boot` (`takeGatewayLockOrExit`, apps/ethos/src/lib/gateway-inbound-durability.ts) before any store is opened, one attempt (`timeoutMs: 0`), refusal exits 3 (`GATEWAY_LOCK_EXIT_CODE`), which `ethos run-all` and the desktop app read as "already running". A caller of `acquireSentinelLock` in `packages/wiring/src/backup/sentinel-lock.ts`, which holds the `node:fs` calls; this file supplies only settings (60s window for a body with no readable pid) and refusal text. Per state dir, not per machine, so two `ETHOS_STATE_DIR` profiles run two gateways
packages/wiring/src/identity-map.ts — no raw `node:fs` of its own. `acquireIdentityMapLock`'s `users/identity-map.json.lock` sentinel is held across one mint's re-read → merge → `Storage.writeAtomic` → read-back, and is a caller of `acquireSentinelLock` in `packages/wiring/src/backup/sentinel-lock.ts`, which holds the `node:fs` calls. `writeAtomic` keeps the map from being torn but provides NO isolation: without the lock another process's mint can land between this one's re-read and its rename and be replaced, and that sender is re-minted under a fresh userId on their next message, splitting their `USER.md` across two ids. A contended mint waits (bounded, `LOCK_WAIT_MS`) and then THROWS rather than writing unlocked or handing out an unrecorded userId; a body with no readable holder is stale past `UNREADABLE_LOCK_STALE_MS`. The map itself still goes through Storage
packages/wiring/src/backup/holder-identity.ts readFileSync — reads `/proc/sys/kernel/random/boot_id` on Linux, the kernel's per-boot UUID, so the `.restore-in-progress` sentinel and the `backups/.lock` body can record WHICH BOOT their pid belongs to. A system path under `/proc`, never `~/.ethos/` — the same rationale as `extensions/skills/src/skill-compat.ts`'s `$PATH` walk. It exists because `process.kill(pid, 0)` answers "is some process wearing this number", not "is the holder still running": after a reboot a recycled pid reads as alive and the lock would never expire. That used to be capped with a wall clock (24h/36h), which preempted holders that were demonstrably ALIVE — a silent two-writer corruption traded against a deadlock that is loud and an operator can clear. Boot identity answers the recycled-pid case exactly instead. Linux is the only platform that records one: macOS, Windows and everything else return `null`, because the derivations available there — `Date.now()/1000 - os.uptime()` on macOS, `kern.boottime` (which XNU adjusts whenever the calendar clock is set), `GetTickCount64` on Windows (which excludes sleep) — are wall-clock or sleep-sensitive quantities, and a wrong boot identity preempts a demonstrably live holder, which is the corruption the module exists to prevent. An unknown or mismatched boot identity means "cannot prove a different boot", so a live pid is never taken over automatically; the cost off Linux is that a recycled pid leaves the lock for an operator to clear by hand, which both refusals already tell them how to do
Error contract: read/exists/mtime return null for missing paths (common case, not exceptional). Everything else throws. ScopedStorage throws BoundaryError (also exported from @ethosagent/types) when a path is outside the allowlist; surfaces translate it into a user-facing tool error.

Atomicity: use writeAtomic for any file where a partial write would corrupt state (config, keys, audit logs). It's a separate method, not an option, to prevent the "did the writer remember?" footgun.

See plan/storage_abstraction.md for the full migration plan (4 phases) and the Storage interface spec.

SQLite durability posture (`synchronous`)
Every store above runs `journal_mode = WAL`. The `synchronous` setting on top of it is decided PER STORE, and it is not a performance knob — it is a durability trade. Do not sweep it across the roster in either direction.

What the trade is, per [sqlite.org](https://www.sqlite.org/pragma.html#pragma_synchronous): in WAL mode `synchronous = NORMAL` is "safe from corruption" and "always consistent", but it stops fsyncing the WAL on every commit, so "a transaction committed in WAL mode with synchronous=NORMAL might roll back following a power loss or system crash". Application crashes lose nothing — the OS still holds the writes. The exposure is exactly: a power cut or kernel panic can drop the last few transactions. Measured on this repo's write paths, that fsync is ~4.5 ms and is 42x–330x the cost of the write it protects; the cost is per-COMMIT, not per-row, so it is the same ~4.5 ms whatever the row holds.

`NORMAL` — reconstructible or expendable data on a hot path:

| Store | Why NORMAL is safe here |
|---|---|
| `extensions/channel-transcript-sqlite/` | Observational: lines other people said in a watched room, on a retention window with a prune cron. One commit per observed message, inline on the gateway's inbound path, in a synchronous API — every ms stops the event loop for every bot. |
| `extensions/observability-sqlite/` | Telemetry with an explicit retention window. Many commits per turn (a span per tool call and per LLM call, plus events and counters). The tail a power cut drops belongs to a turn that did not finish either. |
| `extensions/session-cards/` | A card is a rendering of a tool result, and the store already degrades one card at a time by design (an unparseable row is skipped on read). |

`FULL` — a lost transaction breaks a guarantee made elsewhere. All of these are pinned by a `durability posture` test in the store's own `__tests__`, so a blanket change cannot take them silently:

| Store | Why FULL stays | Hot? |
|---|---|---|
| `extensions/delivery-ledger/` | Its whole purpose. An obligation is written `pending` BEFORE the platform call so the sweep can redeliver; losing that row loses the reply for good. | No — ~2 commits per reply. |
| `extensions/job-store/` | A `queued` row is often the only record that work is owed, and the user was told the job started. | No — a few commits per job; heartbeat is 30s. |
| `extensions/notify-queue/` | A queued wake notice is work owed to a person; a lost enqueue is never retried. | No — one commit per notification. |
| `extensions/outbox/` | A pending publication is work owed to a person; a lost approve silently drops it. | No — a handful of commits per publication. |
| `extensions/inbound-dedup/` | It IS the durable half of dedup. A power cut is the one restart that can roll back the last sightings, and a platform retry afterwards is a second billed LLM turn replying to an answered message. | No — `seen()` runs only on an in-memory Set miss. |
| `extensions/inbound-spool/` | A `received` row is a message the user sent and was never answered; losing it is the failure the store exists to prevent. | No — a turn is three commits (`accept`, `markProcessing`, `markDone`) around an LLM turn that takes seconds, four when it starts a tool (`markToolStarted`); a message consumed without a turn is two (`accept`, `markDone`), and so is a steer folded into a running turn (`accept`, `markAbsorbed` — its terminal rides in its turn's `markDone` transaction). |
| `extensions/call-log/` | `ringing`/`live` rows are LIVE STATE, not history — nothing deletes them however old they look. | No — a few commits per phone call. |
| `packages/a2a/src/sqlite-task-store.ts` | The idempotency key surviving a restart is the point of the store; losing it re-runs a task that already ran. | No — writes at task boundaries. |
| `extensions/memory-vector/` | `memory.db` is the source of truth for memory content, not an index over it — `exportTo` writes markdown, but nothing rebuilds the table from it. | No — every write is gated behind an embedding pass. |
| `extensions/session-sqlite/` (store, context log, api-key store — three handles on one file, and `synchronous` is per-connection) | sessions.db is the agent's memory; the reply has already gone out, so a rolled-back tail leaves the transcript and the user's chat window disagreeing. An API key is shown once and never again. | No — a handful of rows around an LLM call that takes seconds. |

The setting deliberately does NOT live in `packages/sqlite` (the shim). A shim-wide default would be exactly the blanket decision this table exists to prevent. Stores outside this roster (`kanban-store`, `goal-store`, `dashboard`, web-api's `idempotency-store`) have not been assessed and remain at SQLite's `FULL` default.

Adding a new LLM provider
Create extensions/llm-<name>/src/index.ts — implement LLMProvider from @ethosagent/types
Create extensions/llm-<name>/package.json — depend on @ethosagent/types: workspace:*
Add path alias to root tsconfig.json → "@ethosagent/llm-<name>": ["./extensions/llm-<name>/src"]
Wire it in apps/ethos/src/wiring.ts under a new config.provider value
LLMProvider.complete() must return AsyncIterable<CompletionChunk>. Map provider-specific streaming events to the CompletionChunk discriminated union (9 variants in packages/types/src/llm.ts; the frozen list is pinned by packages/types/src/__tests__/llm-provider-drift.test.ts).

Adding a new tool
Tools live in extensions/tools-* packages and register with DefaultToolRegistry at wiring time. To add one:

Implement Tool<TArgs> from @ethosagent/types
execute(args, ctx) must return Promise<ToolResult> — { ok: true, value: string } or { ok: false, error, code }
Set toolset to group the tool (e.g. 'file', 'web', 'terminal')
Set maxResultChars to limit output — executeParallel trims and appends [truncated] if exceeded
Declare isAvailable?() if the tool requires env vars or external services
Wire it in apps/ethos/src/wiring.ts so it's registered on startup
Adding a personality
Drop a directory in ~/.ethos/personalities/<id>/:

<id>/
├── SOUL.md        ← first-person identity (who am I, how do I speak)
├── config.yaml     ← name, description, model (a role or a modelRegistry alias)
└── toolset.yaml    ← flat list of allowed tool names
config.yaml is simple key: value (no nested YAML). Parsed by parseConfigYaml() in extensions/personalities/src/index.ts.

FilePersonalityRegistry.loadFromDirectory() is mtime-cached — it re-reads a personality only when one of its six fingerprinted paths (config.yaml / SOUL.md / toolset.yaml / mcp.yaml / tools.yaml / the skills/ directory — the list is owned by `FilePersonalityRegistry.loadOne`) changes on disk; a no-change refresh is ~6 mtime reads per personality dir with no read()/re-parse. Hot-reload is wired at the surfaces that resolve a personality, not inside the loop: the gateway refreshes every loop registry before it dispatches a turn and at the top of the `/personality` handler (via the optional `personalityDirectory` seam on GatewayConfig, assembled in apps/ethos/src/commands/gateway.ts); web-api's PersonalitiesService refreshes before list/get/characterSheet, and the chat/completions services refresh the loop registry before each turn (`refreshPersonalities` from createAgentLoop's return, threaded through createWebApi); the gateway/serve cron registries reload before each firing. A personality dropped into or edited under ~/.ethos/personalities/ is therefore usable on the next turn/command in every process — no restart. The seams are optional: absent (tests, standalone) → no refresh, and `/personality <unknown>` is validated against the just-refreshed registry so an unknown id is refused instead of silently falling back to the default.

Verify what you built with ethos personality show <id> — it prints the generated character sheet (identity, routing, memory scope, toolset, MCP servers, plugins, fs_reach). renderCharacterSheet() in @ethosagent/personalities is the single generator; the Web Personalities tab renders the same artifact via the personalities.characterSheet RPC.

What does NOT belong on PersonalityConfig (Phase 30.8, amended)
The schema is frozen. The line is IDENTITY vs SETTING, not visible vs invisible.

How a personality PRESENTS itself is identity, and is in scope: which voice it speaks in (voice.tts_voice), and how its call is drawn (voice.call_style). A personality is not only its tools and its plugins — it is also how it looks and feels, and a framework whose agents are all interchangeable grey is not showing you a team. These land as SUB-KEYS of the identity blocks that already exist (today: voice), never as new top-level fields, and never as a metadata passthrough.

Still NOT personality concerns — they belong in skills, in display.* / voice.* in ~/.ethos/config.yaml, or in per-channel adapter config:

voice MODES, VAD tuning, endpointing, barge thresholds — tuning, not identity
emotion / mood / sentiment tags
label or response templates
per-channel UI affordances (one personality rendering differently on Slack than on Telegram)
operator and deployment concerns — transport, credentials, provider rosters, endpoints, anything an operator sets once for the machine
untyped metadata passthroughs — a typed contract does not get an escape hatch meaning "anything"
The test: could two deployments of the SAME personality reasonably disagree about it? Then it is a setting and belongs to the operator. Would changing it make this feel like a different agent? Then it is identity.

Decision-layer enablement is identity (decision-provider-personality amendment). Which decision model a personality uses (`decisions.provider`) and whether each decision site runs for it (`decisions.sites.injection|approver|router: off|shadow|on`) belong to the personality: the same agent with and without a calibrated judgement layer on its approvals is a different agent. The decision provider itself — its credentials, endpoint, model pin, per-site budgets and measured thresholds — stays a setting in `decisions.*` in `~/.ethos/config.yaml`: a machine with no key can always veto, and a threshold is a measurement, not a preference. The field is `PersonalityConfig.decisions` (packages/types/src/personality.ts), parsed by `buildDecisionsConfig` (extensions/personalities/src/index.ts). A site runs only when both halves say so (`resolvePersonalityDecisionSite`, packages/config/src/decisions.ts), resolved per call at each site: the router in `createDecisionTierRouter` (packages/wiring/src/decision-router.ts), the injection classifier in `createDecisionInjectionClassifier` (packages/wiring/src/decision-injection-classifier.ts), the approver in `createSmartApprover` (packages/wiring/src/smart-approver.ts). A global `decisions.sites.*` line in `~/.ethos/config.yaml` is warned about and never read (`describeLegacyDecisionSite`, same config file).

skin, verbosity and busy-input mode stay removed. This amendment does not re-add them; per-personality display overrides return only as specific, argued keys on an identity block, not as a general licence. Adding a top-level field to PersonalityConfig still requires the personality-schema-change label, two-maintainer approval, and bumping .personality-field-count in the same commit. The mechanical CI gate (packages/types/src/__tests__/personality-field-count.test.ts) fails if the count drifts — a presentation sub-key must not move it. See CONTRIBUTING.md for the full rule, and docs/content/building/explanation/personality-governance.md for why.

Session key convention
CLI sessions use cli:<cwd-basename> as the session key. Different working directories get separate conversation histories. /new in chat appends :${Date.now()} to force a fresh session.

SQLite getMessages(sessionId, { limit }) returns the most-recent limit messages in chronological order (using rowid DESC in the inner query, then reversing). This is intentional — the LLM sees the latest context, not the oldest.

Single-owner contracts (2026-09-12)
Four concerns had two owners each; the second owner is gone. Adding a third writer re-creates the bug the fix removed, so go through the owner:

| Concern | The one owner | What a second owner cost before |
|---|---|---|
| `providers.N.*` lines and quoted config scalars | `parseProviderChain` / `renderProviderChain` / `externalizeProviderChain` / `parseConfigScalar` / `quoteConfigScalar` in `packages/config`, used by the CLI writer AND `ConfigRepository` | any unrelated web save dropped a chain entry's `region`/`apiVersion`/`awsProfile` and every API-key reference |
| Which memory backend a surface reads and writes | `createMemoryBundle` → `CreateAgentLoopResult.memoryBundle`, injected into every host (`createWebApi` requires it) | under `memory: vault` the web editor, Timeline and restore wrote markdown the agent never read |
| Goal store + the executor that runs goals from it | `CreateAgentLoopResult.goals` (`{ store, executor }`), built together in wiring; `GoalsService` borrows the pair | desktop goals sat `running` forever with nothing executing them |
| Which adapter delivers a tracked send | `Gateway.adapterForBot(botKey, platform)` — every ledger-backed path (replies, sweep, `notifyTracked`, wakes, clarify notices) | with two bots on one platform, bot A delivered bot B's reply and A's success marked B's obligation delivered |

Two lifecycle rules landed with them. A consumer of `AgentLoop.run()` must drain the iterator to exhaustion — `done` is the answer, not the end of the turn, and a `break` skips `runTurnComplete`, the turn-end memory flush and auto-compaction (deliver the answer at the terminal event, keep pulling, release the lane only when both are done; see `Gateway.runTurn` and `extensions/gateway/src/__tests__/turn-tail.test.ts`). And whatever assembles a runtime returns an idempotent `dispose()` registered beside construction (`DisposerStack` in `packages/wiring`): borrowers never dispose borrowed services, and a host closes only what it opened.

Memory
Memory is a scope-bound key/value store. Every read and write carries an opaque `scopeId`; the provider routes storage accordingly. Conventional scope prefixes:

| Prefix | Set by | Storage root |
|---|---|---|
| `personality:<id>` | Personality wiring | `~/.ethos/` |
| `team:<id>` | Team wiring | `~/.ethos/teams/<id>/memory/` |

**Personality scope** ships two default keys:
- `MEMORY.md` — rolling project context, updated each session.
- `USER.md` — persistent user profile across sessions and personalities.

**Team scope** ships an arbitrary topic set — one markdown file per topic (e.g. `architecture.md`, `decisions.md`, `onboarding.md`).

The canonical contract is `MemoryProvider` in `@ethosagent/types`. See ARCHITECTURE.md §VII for the frozen-schema roster.

`MemoryProvider.sync()` applies `MemoryUpdate[]`:

- `action: 'add'` → appends to the end of the key's content.
- `action: 'replace'` → overwrites the entire key.
- `action: 'remove'` with `substringMatch` → removes lines containing the substring.
- `action: 'delete'` → removes the key entirely (team scope).

`prefetch()` returns `null` if all keys are empty or absent — the system prompt is built without a memory section.

Memory tool reference
Six tools ship in `@ethosagent/tools-memory`. They are registered at wiring time and gated by personality toolset.

**Personality memory** (toolset: `memory`)

| Tool | Required params | Optional params | Behaviour |
|---|---|---|---|
| `memory_read` | — | `store: 'memory' \| 'user' \| 'both'` (default: `'both'`) | Reads `MEMORY.md`, `USER.md`, or both via `prefetch()`. Returns formatted content or an empty notice. |
| `memory_write` | `store: 'memory' \| 'user'`, `action: 'add' \| 'replace' \| 'remove'`, `content` | `substring_match` | Writes to `MEMORY.md` (`store='memory'`) or `USER.md` (`store='user'`). For `action='remove'`, uses `substring_match` if supplied, otherwise uses `content` as the match string. |
| `session_search` | `query` | `limit` (default 10, max 50) | Full-text search over session history. Returns timestamped snippets. |

**Team memory** (toolset: `team_memory`, requires `ctx.teamId`)

On first team boot, wiring auto-seeds two empty bootstrap topics — `onboarding.md` and `decisions.md` — so the team memory directory is never empty when an agent first looks at it (see `seedTeamMemory` in `packages/wiring/src/index.ts`). At session start, a lazy index injector (`createTeamMemoryIndexInjector`, same file) injects just the topic names (not content) into the system prompt; agents load each topic on demand via `team_memory_read`.

| Tool | Required params | Optional params | Behaviour |
|---|---|---|---|
| `team_memory_read` | `key` | — | Reads one topic file (`key` + `.md` suffix appended automatically). Keys must be alphanumeric, hyphens, underscores. |
| `team_memory_write` | `action: 'add' \| 'replace' \| 'remove' \| 'delete'`, `key` | `content`, `substring_match` | Writes to a team topic file. `add`/`replace` require `content`; `remove` strictly requires `substring_match` (returns `input_invalid` if absent — unlike personality `memory_write`, which falls back to `content`); `delete` removes the file entirely. |
| `team_memory_search` | `query` | `limit` (default 5, max 20), `mode: 'keyword' \| 'semantic' \| 'hybrid'` | Keyword search over team memory topics. Returns matching topic files. |

Adding a new memory backend
Mirrors the "Adding a new LLM provider" pattern.

1. Create `extensions/memory-<name>/src/index.ts` — implement `MemoryProvider` from `@ethosagent/types`. The five methods are `prefetch`, `read`, `search`, `sync`, `list` — no more, no fewer.
2. Create `extensions/memory-<name>/package.json` — depend on `@ethosagent/types: workspace:*`.
3. Add path alias to root `tsconfig.json`: `"@ethosagent/memory-<name>": ["./extensions/memory-<name>/src"]`.
4. Wire it in `packages/wiring/src/index.ts` under a new `config.memory` value (current values: `'markdown'`, `'vector'`).
5. The drift gate test (`packages/types/src/__tests__/memory-method-count.test.ts`) asserts exactly five methods. It fails if you add a sixth without bumping the manifest in the same commit — that's intentional schema discipline.

Tool result budget
AgentLoop sets resultBudgetChars: 80_000 by default. ToolRegistry.executeParallel() splits this evenly across concurrent tool calls. Each result is post-trimmed with a [truncated — N chars total] marker if it exceeds the per-call budget.

Tools can declare a lower maxResultChars (e.g. read_file with pagination). The actual budget per call is Math.min(perCallBudget, tool.maxResultChars ?? perCallBudget).

Key conventions
No console.log in library code — only in CLI (apps/ethos/src/). Some console.warn/error lingers in extensions/cron, extensions/plugin-loader, and extensions/tools-mcp; do not add new ones.
All imports are extensionless — import './foo' not import './foo.ts' or import './foo.js'. This is the one hard rule; tsx handles it.
Workspace package.json exports point to ./src/index.ts — so Node 24 can run them directly in dev without a build step.
biome check --write . auto-fixes import order, formatting, and safe lint issues. Run it before committing.
STRICT SQLite tables — both sessions and messages use STRICT mode. All column types must match exactly.
@ethosagent/sqlite (node:sqlite shim) is synchronous — all SessionStore methods wrap it in async but never actually await I/O. Keep query logic tight; no async operations inside the synchronous db.prepare().run() calls.
Personality toolset is enforced — DefaultToolRegistry.toDefinitions(allowedTools) filters what the LLM sees, and executeParallel rejects calls outside the allowlist (tool-registry.ts:57). AgentLoop reads personality.toolset and passes it through (agent-loop.ts:140,265,396). Disallowed tools get a tool_result with is_error: true to keep the Anthropic message contract intact.
Running the project
make prepare        # pnpm install
pnpm dev            # start chat (tsx apps/ethos/src/index.ts)
pnpm check          # typecheck + lint + test
pnpm test           # vitest run
pnpm typecheck      # tsc --noEmit
pnpm lint           # biome check .
pnpm lint:fix       # biome check --write .
First time: pnpm dev auto-runs setup if ~/.ethos/config.yaml is missing.

Learnings from building this codebase
Concrete gotchas and non-obvious decisions that emerged during development. Read this before making changes in any of these areas.

SQLite + FTS5: rowid is a pseudo-column
SELECT * does not include rowid. The FTS5 external content table uses triggers that reference new.rowid — this works because rowid is SQLite's implicit integer row ID, distinct from any TEXT PRIMARY KEY you declare. When you need rowid in a subquery result (e.g. for tie-breaking), you must explicitly select it: SELECT *, rowid AS _row FROM messages. The outer query can then ORDER BY _row.

The symptom when you forget: SqliteError: no such column: rowid on the outer ORDER BY.

SQLite: same-timestamp inserts need rowid tie-breaking
getMessages(sessionId, { limit }) returns the most-recent N messages in chronological order. The inner query sorts DESC to pick the tail, the outer reverses to ASC. When multiple messages share the same timestamp (common in tests and fast insert loops), the DESC order is non-deterministic without a secondary key. Always use ORDER BY timestamp DESC, rowid DESC in the inner query and ORDER BY timestamp ASC, rowid ASC in the outer.

STRICT tables in SQLite
Both sessions and messages use STRICT mode. This means column type enforcement is real — inserting a TEXT into an INTEGER column throws immediately instead of silently coercing. Keep all values properly typed when calling .run().

AgentLoop: before_tool_call hook must prevent execution, not just emit events
The hook fires before executeParallel. If you only emit tool_end ok:false but still add the tool to execInputs, the tool runs anyway. The correct pattern: check beforeResult.error → add to a rejected list → exclude from execInputs. Then persist an error tool_result for rejected tools so the LLM history stays consistent (Anthropic requires a tool_result block for every tool_use block in the preceding assistant message).

Anthropic API: every tool_use needs a matching tool_result
When the assistant message contains tool_use content blocks, the following user message must contain tool_result blocks for every one — including rejected or blocked tools. If a hook blocks a tool call, still persist a tool_result with is_error: true and the rejection reason. Missing tool_result blocks cause Anthropic API validation errors.

getMessages returns newest N, not oldest N
The SessionStore.getMessages(sessionId, { limit }) contract returns the most-recent limit messages in chronological order. This is the tail of the history, not the head. The in-memory and SQLite implementations both use a DESC-then-reverse pattern. If you see the agent losing recent context on long conversations, this is the first thing to check.

Anthropic SDK: cache tokens are in message_start, not message_delta
event.message.usage in the message_start event contains cache_read_input_tokens and cache_creation_input_tokens (when prompt caching is active). These fields are not in the SDK's Usage type — cast to access them: event.message.usage as Anthropic.Usage & { cache_read_input_tokens?: number; cache_creation_input_tokens?: number }.

Anthropic SDK: extended thinking needs any cast for params
The thinking and betas fields for extended thinking are not in the SDK's MessageStreamParams type yet. The // biome-ignore lint/suspicious/noExplicitAny pattern is intentional here — don't try to type it more narrowly.

OpenAI tool call streaming: index-keyed, not ID-keyed
OpenAI streams tool calls as deltas on choices[0].delta.tool_calls[index]. The first delta for a given index has the id and name; subsequent deltas only have arguments. Build a Map<number, { id, name, args }> keyed by index. Don't try to key by id — it arrives late and is sometimes empty on early deltas.

SQLite — @ethosagent/sqlite wraps node:sqlite
@ethosagent/sqlite wraps Node 24's built-in node:sqlite (DatabaseSync) with a synchronous API. No native dependencies — no prebuild downloads, no C++ compilation needed. Import: `import Database from '@ethosagent/sqlite'`.

openai package has a zod v3 peer dep — intentionally ignored
openai@4.87+ lists zod@^3 as a peer dependency. Ethos uses zod@4. The zod dep is only used by openai for its structured outputs / .parse() features, which we don't use. It's suppressed via peerDependencyRules.ignoreMissing: ["zod"] in pnpm-workspace.yaml. Don't remove this or pnpm will emit peer conflict warnings on every install.

Workspace package.json exports point to source
All workspace package exports use "import": "./src/index.ts" (not ./dist/index.js). This lets Node 24 + tsx resolve them directly without a build step. The "production" condition points to ./dist/index.js for when you actually build. If you add a new workspace package, follow this pattern.

Biome v2: files.includes uses trailing slash for folder negation
"!dist/" (with trailing slash) ignores the dist directory. "!**/dist/**" also works but "!dist" (no slash) does not — Biome v2 changed this. The pattern is already correct in biome.json; don't "fix" it.

import.meta.dirname for locating built-in data files
extensions/personalities/src/index.ts uses join(import.meta.dirname, '..', 'data') to find the built-in personality data directory. import.meta.dirname is available in Node 21.2+ (and therefore Node 24). Don't replace with fileURLToPath(new URL(..., import.meta.url)) — that's the Node 18/20 workaround and adds noise.

tsx + extensionless imports: why we don't use --experimental-strip-types
Node 24's --experimental-strip-types requires explicit file extensions in imports (.js or .ts). This conflicts with TypeScript's extensionless import convention. tsx handles extensionless imports and tsconfig path aliases correctly. The decision to keep tsx was made explicitly — don't try to migrate to --experimental-strip-types without also adding extensions to every internal import.

Prompt ordering is static-first, dynamic-tail — keep it that way
The system prompt is assembled STATIC-FIRST (injection-defense prelude → SOUL.md → priority-sorted injectors) with DYNAMIC sections at the TAIL (memory snapshot, progressive file-context, team topic index) — see `packages/core/src/agent-loop/stages/context-assembly.ts`. NO per-turn-varying text (dates, timestamps, turn counters) appears anywhere in the prompt. This is what keeps the static prefix byte-identical across turns so prefix caching works — Anthropic cache breakpoints, vLLM `--enable-prefix-caching`, and Ollama keep-alive all reuse the unchanged prefix. Any new injector MUST emit content that depends only on static inputs (personality, platform), or render per-turn/dynamic content as an `append` so it lands in the tail. Don't put a date/clock/counter in an injector. The regression guard is `packages/core/src/__tests__/prompt-prefix-stability.test.ts` — it drives two consecutive turns with unchanged memory and asserts a byte-identical static prefix; if you break the ordering it fails.

Local-serving note: to exploit the stable prefix, run vLLM with `--enable-prefix-caching` and rely on Ollama's keep-alive so the loaded prefix survives between turns.

noNonNullAssertion is enforced by Biome
array[n]! and map.get(key)! are blocked. Preferred patterns:

array[n] ?? fallback — safe default
const val = map.get(key); if (val) { ... } — explicit guard
Extract into a const before using in a filter: const match = update.substringMatch; if (!match) break;

API response type safety
Never cast API response types with `as`. The oRPC typed client infers return types — use those. For SSE events, parse with the Zod schema from `@ethosagent/web-contracts`. For external JSON (localStorage, URL params), use Zod `.safeParse()` with a fallback rather than `as`.

Design system
Always read DESIGN.md before making any visual or UI decision. All font choices, colors, spacing, motion, and aesthetic direction are defined there. Do not deviate without explicit user approval.

The web UI (in development) references DESIGN.md tokens via Antd ConfigProvider. Other surfaces (TUI, VS Code extension, email digests, CLI) consume the same tokens — see DESIGN.md "Cross-surface token mapping" for the per-surface render rules.

When reviewing or writing code that touches UI, flag any deviations from DESIGN.md (slop blacklist, font choices, color hex values, motion durations, "cards earn existence" rule).

Docs system
Documentation work (Docusaurus pages, READMEs, llms.txt, SOUL.md files) is governed by the `/docs` skill at [.agents/skills/docs/SKILL.md](.agents/skills/docs/SKILL.md). The skill auto-suggests for any doc work and defines page kinds, the front-matter contract, voice rules, anti-patterns, and the page-acceptance checklist. Invoke it before touching any doc.

gstack
Available skills: /review, /plan-eng-review, /plan-ceo-review, /plan-design-review, /design-consultation, /browse, /investigate, /careful, /ship, /qa, /retro.
