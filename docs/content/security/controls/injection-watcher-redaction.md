---
title: "Security controls: injection, watcher and redaction"
description: "Provenance wrapping, classifiers, memory scanning, watcher and redaction."
kind: reference
audience: shared
updated: 2026-11-03
---

## Synopsis {#synopsis}

Prompt-injection defenses, the watcher and credential redaction. Part of the [Security controls](../controls.md).

## Prompt-injection defenses {#prompt-injection-defenses}

Tool results that re-enter the LLM context are the dominant vector for indirect prompt injection. Three layers handle this, and all three act on the results of tools that declare `outputIsUntrusted`.

### Provenance wrapping {#provenance-wrapping}

*Status: Shipped.*

Every result from a tool that declares `outputIsUntrusted` — success or error — is wrapped with provenance markers before it enters the LLM context (`handleUntrustedResult` in `packages/core/src/agent-loop/result-defense.ts`, called from `packages/core/src/agent-loop/stages/tool-processing.ts`). The marker names the tool and, where the arguments carry one, the source path, URL, command or query (`describeSource`). A result from a tool that does not declare `outputIsUntrusted` is not wrapped.

Two related mechanisms sit beside it:

| Mechanism | What it covers | Enforced by |
|---|---|---|
| Result delimiter fence | Every successful result, and every error that went through the untrusted path, is fenced in `===TOOL_RESULT_START:<name>===` … `===TOOL_RESULT_END===`, with forged delimiters in the content escaped. On by default; `safety.injectionDefense.toolResultDelimiters: false` turns it off | `tool-processing.ts` |
| Inbound channel messages | The gateway wraps each admitted message and its channel history (see [Context-visibility filter](channel.md#context-visibility-filter)) | `wrapUntrusted` calls in `extensions/gateway/src/index.ts` |

Skill and context files are not wrapped. Their lines are sanitized instead (see [Memory injection scanning](#memory-injection-scanning)).

- Source: `wrapUntrusted` in `packages/safety/injection/src/wrap.ts`
- System prompt: `INJECTION_DEFENSE_PRELUDE`, pushed into every personality's prompt by `packages/core/src/agent-loop/stages/context-assembly.ts` (a compact variant when `promptBudget.compactPrelude` is set)

### Two-tier classifier {#two-tier-classifier}

*Status: Shipped.*

Tier 1 runs on every untrusted result. It is regex-based:

| Check | Rules |
|---|---|
| `shortPatternCheck` (`packages/safety/injection/src/pattern-check.ts`) | `ignore-instructions`, `disregard`, `forget-instructions`, `role-override`, `new-instructions`, `inline-system`, `inline-assistant`, `template-token`, `bidi-override`, `zero-width` |
| `c2PatternCheck` (same file) | Exfiltration phrasing (`c2-exfiltrate-*`), `c2-system-override`, memory-persistence phrasing (`c2-memory-write`, `c2-remember-always`, `c2-persist-instruct`), secret-read phrasing (`c2-read-secrets`, `c2-exfil-keys`), and others |
| Template-token strip | Chat-template tokens are stripped by `wrapUntrusted`; a strip counts as a Tier-1 hit |

Tier 1 has no base64-blob detector; only the phrase rule `c2-exfiltrate-encode` touches encoding.

Tier 2 is an LLM classifier (`createLLMClassifier` in `packages/safety/injection/src/classifier.ts`, wired in `packages/wiring/src/build-agent-loop.ts`). It runs when Tier 1 hit, when the content is longer than 500 characters, or when `safety.injectionDefense.classifier.alwaysCallLLM` is `true` (`shouldCallLLM` in `result-defense.ts`). There is no sampling budget. Limitation: a payload of 500 characters or fewer that Tier 1 misses is not sent to Tier 2 unless `alwaysCallLLM` is set.

A Tier-2 failure is fail-open: the turn continues on the Tier-1 verdict and records `audit.block` with code `injection_classifier_failed`. A flagged result records `audit.block` with code `injection_detected` and shows the user a warning.

- Sources: `packages/safety/injection/src/classifier.ts`, `packages/safety/injection/src/pattern-check.ts`, `packages/core/src/agent-loop/result-defense.ts`

### Post-read tool downgrade {#post-read-tool-downgrade}

*Status: Shipped.*

Any result from an `outputIsUntrusted` tool — flagged or not, success or error — arms the downgrade (`untrustedReadThisIteration` in `tool-processing.ts`, then `advanceDowngrade` in `packages/core/src/agent-loop/stages/per-call-enforcement.ts`). While it is armed, calls to the downgraded tools are refused with `DOWNGRADE_REJECTION_MESSAGE` (`isDowngraded`, same file). It stays armed for the next `turns` loop **iterations** (default 2) within the same run, and clears when the user sends a new message, because each run starts the counter at zero. The three persistence tools — `memory_write`, `team_memory_write`, `skill_propose` (`RUN_SCOPED_DOWNGRADE_TOOLS`) — are the exception: once the run has seen any untrusted result they stay refused until the run ends, because the untrusted text is still in context after the window lifts. The refusal names no retry. Tool calls a `run_code` script makes follow the same rule against the same run state: `ScriptToolBridge` (`packages/core/src/agent-loop/stages/script-tool-bridge.ts`) checks `isDowngraded` before each call, and an untrusted result inside the script arms the downgrade at once (`armDowngrade`), so a later call in the same script is refused too (pinned by `packages/core/src/__tests__/downgrade-memory-writes.test.ts`).

The run-scoped refusal also covers what would carry the untrusted text past this run (V2-SEC-2). The tools that schedule a later run from text this run writes — `cron` create/update, `goal_create`, `kanban_create`, `kanban_create_goal`, `kanban_create_swarm`, `kanban_decompose`, `delegate_task` with `background: true`, `route_to_agent` with `background: true` (a detached job on a mesh peer, whose `BackgroundExecutor` reads no taint), `task_steer` (its text becomes a running background child's `[USER STEER]`; that child's taint was fixed at its start; pinned by `packages/core/src/__tests__/downgrade-derived-runs.test.ts`), and `watcher_create` with a `wake` (its `prompt_prefix` is prepended to every wake prompt; a deliver-only watcher stays allowed) — and `kanban_block`, whose reason becomes the blocked run's summary that the ticket's next dispatch prompt carries (`renderOperatorContext`, `extensions/kanban-store/src/prompt-thread.ts`; pinned by `extensions/tools-kanban/src/__tests__/untrusted-taint.test.ts`; a tainted worker can still park its ticket with `kanban_update_status(status: "blocked")`, which ends the open run with no summary, and the refusal text says so — without it, a standalone `ethos serve` reclaims the stale ticket to `ready` and dispatches it again, `apps/ethos/src/lib/kanban-poll.ts`), are refused for the rest of the run (`RUN_SCOPED_SCHEDULERS` in `per-call-enforcement.ts`; refused rather than marked tainted-origin, because the schedulers that start those runs are not the loop and a mark nothing reads would enforce nothing). `scaffold_personality` and `scaffold_team` write a new personality's SOUL.md or a team manifest through the compose-time Storage, not the turn's `ScopedFsImpl`, so the state-dir write refusal below never sees them; they are refused by name instead (`RUN_SCOPED_PROMPT_WRITERS`, same file; pinned by `extensions/tools-personality-design/src/__tests__/untrusted-taint.test.ts`, and `watcher_create` by `extensions/tools-watchers/src/__tests__/untrusted-taint.test.ts`). A scoped filesystem write into the Ethos state dir — the personality's own `MEMORY.md`/`USER.md`, team memory, skills, another personality's files, `cron/jobs.json` — is refused by `ScopedFsImpl.checkReach` (`writesEthosState`, `packages/core/src/scoped/scoped-fs.ts`), except under a personality's `files/` asset folder; this is what stops `write_file`/`patch_file` (window-only tools) from writing the page's text into `MEMORY.md` once the window lifts. A sub-agent run started inside one of the run's tool calls (`delegate_task`, `mixture_of_agents`) inherits the taint — it starts with the window and the refusals armed — and a sub-agent that reads untrusted content taints its parent, whose context receives its answer (`resolveRunDowngrade` and `runToolsInTaintScope`, same file, through `packages/core/src/scoped/run-taint.ts`). Pinned by `packages/core/src/__tests__/downgrade-derived-runs.test.ts`, `extensions/tools-delegation/src/__tests__/untrusted-taint.test.ts` and `extensions/tools-file/src/__tests__/untrusted-state-writes.test.ts`. A tainted run also skips the opt-in turn-end memory flush (`TurnEndCtx.untrustedSeen`, checked first in `runMemoryFlush`, `packages/core/src/agent-loop/turn-end.ts`; pinned by 'memory flush skips a run that read untrusted content' in `packages/core/src/__tests__/turn-end-consolidation.test.ts`). A background job's own run is detached from the tool call that spawned it, so its taint is carried on the job instead: `EthosJobRunner` passes `RunOptions.onUntrustedRead`, the executor records `BackgroundJob.tainted` at the terminal transition (job-store schema v10), and `Gateway.admitWakeReview` starts a `deliver: 'parent'` review turn of a tainted job with `RunOptions.untrustedOrigin`, which arms the downgrade before its first call (a replayed review reads the flag back from the job store and, when it cannot, starts armed). Pinned by `extensions/job-runner/src/__tests__/untrusted-taint.test.ts` and the tainted-job cases in `extensions/gateway/src/__tests__/parent-review.test.ts`. A job on the ACP coding-agent or Pi runner is marked tainted before the external agent starts (`AcpJobRunner`/`PiJobRunner` call `JobRunnerContext.markTainted`; pinned by the 'the job is marked tainted' cases in their `__tests__/runner.test.ts`), because nothing reports what that process read. The taint link is scoped to the run that owns it: the shared `BackgroundExecutor` and `GoalRunner` start every job and goal run in the async context they were constructed in, not in the tool call that nudged them (`detached` in `extensions/job-runner/src/index.ts` and `extensions/goal-runner/src/index.ts`), and a run with `jobId` or `reviewOfJobId` ignores any ambient link (`resolveRunDowngrade`), so one session's tainted batch neither arms nor is tainted by another session's job (pinned by `extensions/job-runner/src/__tests__/taint-isolation.test.ts` and `extensions/goal-runner/src/__tests__/taint-isolation.test.ts`). The mesh tools carry the taint across the process boundary (MESH-TAINT), where no AsyncLocalStorage link reaches: from a tainted run, `route_to_agent`, `dispatch_team` and `broadcast_to_agents` add `untrustedOrigin: true` to the peer's `prompt` params (`meshTaintParams`, `extensions/tools-delegation/src/index.ts`, reading `runIsTainted`), and `AcpServer` starts that run with `RunOptions.untrustedOrigin` on both the HTTP and the streamed `prompt` (`apps/acp-server/src/index.ts`), so the peer's run starts with the window and the run-scoped refusals armed. The marker only adds refusals. Every mesh answer is untrusted content (`outputIsUntrusted` on all three tools), so an untainted run that asks a peer is tainted by the answer, whatever that peer read. A run started by an inbound A2A peer message is always armed (`createA2aRunner`, `apps/ethos/src/commands/serve-a2a-runner.ts`): the message is another operator's agent's text, already fenced as untrusted (`wrapUntrusted` in `packages/a2a/src/rpc.ts`), and no wire field can opt it out. The cost has two parts. The step window: a peer-invoked skill cannot use a downgraded tool (`terminal`, `write_file`, …) in its first model steps (2 by default). And the run-scoped refusals, which last for the WHOLE run, not just those steps: `memory_write`, `team_memory_write` and `skill_propose`; the schedulers above (`cron`, `goal_create`, the `kanban_create*` tools and `kanban_decompose`, `kanban_block`, `delegate_task` and `route_to_agent` with `background: true`, `watcher_create` with a `wake`); `scaffold_personality` and `scaffold_team`; every scoped write into the Ethos state dir; and the turn-end memory flush. So a peer-invoked skill that needs to remember, schedule or scaffold anything is refused for the entire run (`isDowngraded` and the `RUN_SCOPED_*` sets in `packages/core/src/agent-loop/stages/per-call-enforcement.ts`, armed through `resolveRunDowngrade`). `postReadDowngrade.enabled: false` is the per-personality off switch for both. Pinned by `apps/acp-server/src/__tests__/mesh-taint-e2e.test.ts` (real AgentLoops on both sides of a real socket, including a case that strips the marker in transit and sees the peer write memory) and the MESH-TAINT cases in `apps/ethos/src/commands/__tests__/serve-a2a-runner.test.ts`. The refusal text says the run "is handling untrusted content", read directly or inherited. Not covered: host `terminal`/`process_start`/`run_code` processes (window-only; approval-gated); a mesh peer that is not an Ethos `AcpServer` can ignore the marker.

The default tool list is `DEFAULT_DOWNGRADED_TOOLS` in `packages/safety/injection/src/downgrade.ts`: `terminal`, `run_code`, `run_tests`, `write_file`, `patch_file`, `web_extract`, `browse_url`, `browser_click`, `browser_type`, `process_start`, `process_stop`, `memory_write`, `team_memory_write`, `skill_propose`. A hijacked agent that has just read a poisoned page cannot immediately open a shell or type into a form, and it cannot persist the page's instructions into `MEMORY.md`, team memory or a skill proposal — text that every later system prompt would carry (pinned by `packages/core/src/__tests__/downgrade-memory-writes.test.ts`).

- Source: `packages/safety/injection/src/downgrade.ts`; the gate in `packages/core/src/agent-loop/stages/tool-processing.ts`
- Audit: a refused call records `audit.block` with code `tool_downgraded_post_untrusted_read`
- Per-personality knob: `safety.injectionDefense.postReadDowngrade` — `{ enabled, turns, tools }`. `enabled` defaults to `true`, and `enabled: false` turns the downgrade off for that personality. `tools` replaces the default list.
- Other opt-outs in the same block: `toolResultDelimiters: false` removes the delimiter fence, and `blockSecretResults: false` stops secret redaction of tool results (see [Credential redaction](#credential-redaction)). Wrapping, the prelude and Tier 1 have no knob.

### Memory injection scanning {#memory-injection-scanning}

*Status: Shipped.*

Memory content — `MEMORY.md`, `USER.md`, and team topic files — is sanitized with `sanitize` (`packages/safety/injection/src/prompt-sanitize.ts`). Any line matching an injection pattern such as "ignore previous instructions", `[SYSTEM]`, or a role-override phrase is replaced with `[line removed by injection guard]`.

Memory is a higher-risk surface than context files. A single poisoned line in `MEMORY.md` re-injects into the system prompt on every subsequent turn and every future session. A poisoned `USER.md` crosses [personality](../../getting-started/glossary.md#personality) boundaries, so every personality the user talks to sees it.

| Point | Personality memory | Team memory |
|---|---|---|
| Write | `memory_write` sanitizes before `sync()` (`extensions/tools-memory/src/index.ts`) | `team_memory_write` sanitizes before `sync()` |
| Tool read | `memory_read` sanitizes what it returns | `team_memory_read` sanitizes what it returns |
| Prompt assembly | The memory snapshot is sanitized before the system prompt is built (`packages/core/src/agent-loop/stages/context-assembly.ts`) | Only topic names are injected, not content |

The read-time pass catches content written before scanning existed or edited by hand on disk.

- Audit: none. A removed line is not recorded as an event.

## Watcher {#watcher}

*Status: Shipped (fixed default rule set).*

The watcher is a separate observer in the same process. `createWatcherTap` (`packages/core/src/agent-loop/watcher-tap.ts`) feeds it every tool event synchronously, and the loop consults its decision at iteration boundaries and before each call (`consultWatcherHalt`). Its rules do not depend on any other check classifying a call correctly.

| Rule | Fires when | Decision |
|---|---|---|
| `rate-limit` | More than 60 `tool_end` events in 60 seconds, counted across turns | `pause` |
| `token-budget` | More than 50,000 **output** tokens in one turn | `pause` |
| `compounding-error` | 5 consecutive failures of the same tool | `pause` |
| `suspicious-sequence` | A `read_file`, `search_files` or `terminal` call on a credential-shaped path (`.ssh`, `.aws/credentials`, `.gnupg`, `.netrc`, `/etc/passwd`, `/etc/shadow`, `/etc/sudoers`, `authorized_keys`), followed within the last 4 calls by an exfiltration-shaped tool: one in `EXFIL_TOOL_NAMES` (`web_extract`, `browse_url`, `browser_navigate`, `browser_computed_style`, `video_analyze`, `meet_join`, `browser_type`, `browser_vision_type`, `send_message`, `call`, `a2a_send`, `route_to_agent`, `broadcast_to_agents`, `dispatch_team`) or any `mcp__*` tool (`isExfilShapedTool`) | `terminate` |

A `pause` emits a `halt` event, rejects the pending calls, and ends the turn with one closing model call that has no tools (`replyAfterWatcherPause`). No human review queue holds the call. A `terminate` ends the turn with an `error` event whose code is `watcher_<rule>`.

The list is drawn by destination: it names tools that can carry agent-chosen content to a destination the agent chooses, so a tool that only talks to a fixed provider (`web_search`) is not on it, and `terminal` counts only as a credential read. The list is pinned against the registered tools by `packages/wiring/src/__tests__/watcher-exfil-tool-names.test.ts`: every name must be a real tool, and every tool that declares `allowedHosts: ['*']` must be listed or exempted there with a reason.

- Source: `packages/safety/watcher/src/watcher.ts`, `packages/safety/watcher/src/rules.ts` (`defaultRules`)
- Audit category: `audit.watcher`
- Configuration: none per personality. Wiring always constructs the watcher with `defaultRules()` (`packages/wiring/src/build-agent-loop.ts`). The only bypass is the run option `allowDangerousToolCalls`.

## Credential redaction {#credential-redaction}

*Status: Shipped.*

Redaction runs in two places.

**Before disk.** The observability store redacts every trace attribute, span attribute, event detail and event cause it writes (`packages/safety/redact/src/index.ts` `redactString` / `redactJson`, applied in `extensions/observability-sqlite/src/store.ts`). The built-in pattern set covers Anthropic, OpenAI, Groq and xAI API keys, GitHub tokens, AWS access keys, Google API keys, Telegram, Discord, Slack and Stripe tokens, private keys, JWTs, bearer tokens, a generic-secret shape, and the value of any secret-named assignment or JSON key (`DISCORD_BOT_TOKEN=…`, `export ELEVENLABS_API_KEY=…`, `"api_key": "…"`, tagged `[REDACTED:secret-value]`), `Authorization: Basic` credentials (a base64-shaped value only, so prose such as "Basic auth" is left alone), and the password in URL userinfo (`postgres://user:pw@…`, `redis://:pw@…`). A templated or placeholder value is left alone: a URL password that is wholly `${DB_PASS}`, `$REDIS_PASSWORD`, `{{…}}`, `%(password)s`, `%DB_PASS%`, `<password>`, `****` or `xxxx` (a real password that merely starts with `$`, `%`, `*` or `{`, such as `$ecret…` or a percent-encoded `%40…`, is still redacted), and a secret-named key set to `required`, `none`, `null` or `your_…_here` (pinned by the 'V3-5 letters-only secrets', 'V3-9 URL credentials' and 'V4-1' cases in `packages/safety/redact/src/__tests__/redact-roster-s13.test.ts`). Vendor prefixes match only at an identifier boundary, so a long kebab-case path such as `disk-usage-report-…` (which contains `sk-` mid-word) is left alone. A match is replaced with a labelled tag such as `[REDACTED:anthropic-key]`.

**Before the model.** Every tool result's value, error and structured leaves are scanned (`redactToolResultSecrets` in `packages/core/src/agent-loop/stages/result-redaction.ts`) before any consumer sees the result, including the next turn's context. A detection records a `secret_in_tool_result` safety event, and the detected text is replaced unless the personality sets `safety.injectionDefense.blockSecretResults: false`.

| Knob (`safety.observability`) | Values | What it does |
|---|---|---|
| `storeToolArgs` | `none` \| `redacted` (default) \| `full` | `none` drops tool-call args from spans. `full` skips the personality's `redactPatterns`; the built-in patterns still apply. |
| `storeLlmPayloads` | `none` \| `metadata` \| `full` | `full` stores message content on the LLM span; it is redacted like every other attribute. |
| `redactPatterns` | regex strings | Extra patterns, replaced with `[REDACTED:custom]`. |
| `storeToolBodies` | `none` \| `redacted` \| `full` | Reserved. Accepted and shown on the character sheet, but tool result bodies are never stored in `observability.db` at any setting; only the result size is recorded (pinned by `packages/core/src/__tests__/tool-body-not-stored.test.ts`). |

`ethos support bundle` reads events that were already redacted in the store and strips secret-shaped fields from the config it includes (`stripSecrets` in `apps/ethos/src/commands/support.ts`). `--anonymize` only replaces the home directory, working directory, hostname and username.

- Source: `packages/safety/redact/src/index.ts` (`extensions/observability-sqlite/src/redact.ts` re-exports it)
- Audit: `audit.redacted` is **not** emitted today. `recordRedacted` exists in `packages/wiring/src/observability/ethos-observability.ts` and nothing calls it.

## See also {#see-also}

- [Security controls](../controls.md) — the index page for this reference.
