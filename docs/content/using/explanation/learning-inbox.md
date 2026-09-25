---
title: "Why does a learned change need a replay before it goes live?"
description: "How Ethos measures a drafted skill or Expression change against frozen past tasks, when it promotes on its own, and when a human decides."
kind: explanation
audience: user
slug: learning-inbox
updated: 2026-09-25
---

## Context

An Ethos agent learns from its own work. Overnight it can draft a new [skill](../../getting-started/glossary.md#skill) (a markdown file of instructions the agent loads when relevant), rewrite one that underperformed, or revise the Expression region of a [personality's](../../getting-started/glossary.md#personality) (the directory of files that decides the agent's role, tools and voice) `SOUL.md`. That is useful, and risky: a skill that reads well can still make the agent pick the wrong tool on Tuesday's real request.

Ethos used to decide with an opinion. Nightly skills went live on one LLM "PASS/FAIL" reply. An `auto`-mode Expression draft was applied without anyone evaluating the draft itself. With `autoApprove` on, a skill proposed after a conversation was copied straight into the live skills directory. None of these measured the change.

Now, **nothing a learning path drafts goes live without a `pass` replay or a human.** Every draft becomes a *candidate* in one inbox. A replay runs the candidate against real past tasks, next to what is live today, and scores both. The rest of this page explains what that measurement is, when it is allowed to promote on its own, and what it cannot tell you.

## Discussion

### One inbox for seven paths

Seven code paths used to change a skill or an Expression, feeding three different queues that no single screen showed together. All seven now call `submitCandidate` (`extensions/learning-inbox/src/store.ts`), which writes `~/.ethos/learning/candidates/<id>/candidate.json` with status `pending_replay` and appends the transition to `~/.ethos/learning/audit.jsonl`.

| Origin | What drafts the candidate | Kind |
|---|---|---|
| `fork` | The post-turn improvement fork, after a conversation that crosses `skill_evolution.min_tool_calls` (`extensions/skill-evolver/src/improvement-fork.ts`) | Skill |
| `chat` | The agent's `skill_propose` tool during a chat turn (`packages/wiring/src/compose-tools.ts`) | Skill |
| `nightly` | The nightly pass's skill drafter (`nightly-propose.ts`) and Expression drafter (`apps/ethos/src/commands/nightly.ts`) | Skill, Expression |
| `eval` | `ethos evolve` and `ethos eval --evolve` (`extensions/skill-evolver/src/evolver.ts`) | Skill |
| `cli` | `ethos personality evolve <id>` (`apps/ethos/src/commands/personality-evolve.ts`) | Expression |
| `web` | The Living Soul editor in the web dashboard (`apps/web-api/src/services/personalities.service.ts`) | Expression |
| `legacy` | Files left in the three old skill queues and `learning/pending-expression/`, imported once (`import-legacy.ts`) | Skill, Expression |

A candidate records what it changes (`kind`, and `op`: `create`, `rewrite` or `update`), the live file it would land on (`destination`), a hash of that file's bytes when the draft was made (`baseHash`), the evidence it was drafted from, and the *target cases* it is meant to improve.

### What a replay is

A replay answers one question: does this candidate do better than what is live, on tasks this personality has actually been given?

Each selected case runs twice. The **baseline arm** runs on the live files. The **candidate arm** runs on a loop that sees exactly one path differently: the skill file at its destination, or `SOUL.md` rebuilt with the candidate's Expression and the live Core and Learning Log. `runReplay` (`extensions/learning-inbox/src/replay.ts`) scores every arm on the case's assertions. An arm's score is the fraction of assertions it passed, plus an implicit `completed` check (no `error` event, no `halt`).

| Assertion | Graded by |
|---|---|
| `criteria` (prose) | `llmJudgeScorer` on the default LLM. The grader sees one response and the criterion, never which arm produced it. |
| `contains`, `regex`, `exact` | The eval-harness scorers. |
| `tool_called`, `tool_not_called` | `toolCalledScorer` against the arm's dry-run tool plan. |

### Why a replay cannot touch anything

A measurement that sends messages or edits files is not a measurement. Three layers keep a replay isolated, and each has a named enforcer.

| Guarantee | Enforced by |
|---|---|
| No tool executes. The arm records what it *would* call. | `RunOptions.dryRun`. `DefaultToolRegistry.executeParallel` (`packages/core/src/tool-registry.ts`) returns `synthesizeDryRunResult` without calling `tool.execute`. `runReplay` throws if a caller passes anything but `{ dryRun: true, temperature: 0 }`. |
| A gated `send_message` in the plan queues no outbox row. | The outbox gate lives inside `executeSendMessage`, which a dry run never calls. Pinned by `packages/wiring/src/__tests__/replay-isolation.test.ts`. |
| No write through `Storage` lands. Both arms read through an overlay. | `OverlayStorage` (`extensions/learning-inbox/src/overlay-storage.ts`) throws `BoundaryError` on every write, append, remove, rename, mkdir and chmod. |
| The replay's turns never reach `sessions.db`, never spawn the improvement fork, never write memory. | `CreateAgentLoopOptions.replay` (`packages/wiring/src/index.ts`): an in-memory session store, `disablePostTurnLearning` forced on, memory wrapped read-only. |
| A replay session never becomes learning evidence. | Replay turns use the key `replay:<candidate>:<arm>:<case>`, and `replay:` is in `LEARNING_EXCLUDED_KEY_PREFIXES` (`extensions/learning-inbox/src/cases.ts`). |

The overlay does not police raw SQLite stores (`outbox.db`, `jobs.db`, and the rest). What keeps a replay from publishing through one of them is the dry run, not the overlay.

### Where the cases come from

A *case* is one past task, frozen to `~/.ethos/learning/cases/<personality>/<caseId>.json` and never edited, so a candidate replayed next month runs against the same prompts even after the sessions they came from are pruned. `captureCases` (`cases.ts`) takes sources strongest first:

| Source | Prompt | Assertions |
|---|---|---|
| Done kanban tickets assigned to the personality, with acceptance criteria | Title and body | The criteria prose as one `criteria` assertion. `check:` lines are dropped: they verify workdir facts a dry run cannot produce. |
| Eval tasks with authored expected values | The task | The authored value, keeping its `match` kind |
| Session turns | A real user message, with up to 4 preceding messages as context | "stays true to this Core: …" and "directly addresses the request" |

Sessions Ethos drove itself are never captured: eval runs, replays, the fork, nightly and cron turns, MCP clients, outbox reviews and pack checks (`LEARNING_EXCLUDED_KEY_PREFIXES`). The nightly pass freezes up to 10 new cases per personality per run, and the pool keeps at most 40, evicting the oldest (`CASE_FREEZE_BATCH`, `CASE_POOL_CAP`). A case that is a target of a candidate still in `pending_replay` or `pending_review` is never evicted (`enforceCasePoolCap`, `cases.ts`); if those targets alone exceed 40, the pool holds them all, keeps no other cases, and freezes nothing new until candidates are decided.

A candidate's target cases come from its own evidence: the triggering turn for a fork or chat proposal, the evidence sessions for a nightly skill, the prompts the Judge scored 0 for an `auto`-mode Expression draft, and the low-scoring tasks for an eval rewrite. The rest of the replay is *regression cases* drawn from the pool, newest first. `selectReplayCases` (`replay.ts`) picks at most 8 cases (`learningReplay.maxCases`), at most 3 of them targets, and always keeps one slot for a regression case.

### The verdict rules

`computeVerdict` (`extensions/learning-inbox/src/verdict.ts`) is a pure function of the per-case scores and whether the run stayed within budget. Δ is the candidate arm's score minus the baseline arm's.

| Rule | Holds when |
|---|---|
| (a) | At least 3 cases, **at least 1 target case and at least 1 regression case**, every case ran in both arms, and the run stayed within `learningReplay.maxCostUsd` |
| (b) | No case where the baseline completed and the candidate did not |
| (c) | Mean Δ over target cases is above 0 |
| (d) | Mean Δ over regression cases is at least 0, with at most one regression case below 0 |

The verdict is `pass` when all four hold. It is `incomplete` when (a) fails, because the run could not be scored. Otherwise it is `regress`.

Rule (a) insists on a regression case because rule (d) is the harm check. Over zero regression cases it holds vacuously, so three target cases alone would "pass" having measured only the improvement. A run without one is `incomplete`, and the gate fails closed.

### When a candidate promotes itself

Auto-promotion is the only way a change goes live without a person, and it needs all three of the following. `autoPromotionDecision` (`extensions/learning-inbox/src/auto-promotion.ts`) checks them in order, and `replayAndResolve` is the one caller that turns "yes" into `promote()`:

1. **A `pass` verdict.** An LLM opinion never decides.
2. **The resolver says `auto`.**
3. **A destination only the replayed personality can see.** That is a skill with `skill_evolution.scope: personality`, or an Expression.

The third condition is why **a shared-scope skill always needs a human.** Replay tested it on one personality. Once live in `~/.ethos/skills/` it runs on every personality whose toolset matches its required tools, none of which were measured. The default scope is shared (`liveSkillDir`, `extensions/skill-evolver/src/skill-dir.ts`), so set `scope: personality` on a skill you want promoted unattended.

`resolveAutoPromotion` reads three knobs that used to be read by three different paths. The first knob that is *set* decides, so a personality's explicit `review` beats a global `autoApprove: true`.

| Kind | Precedence |
|---|---|
| Skill | `skill_evolution.promotion` > `evolution_approval_mode` > `autoApprove` in `~/.ethos/evolve-config.json` > review |
| Expression | `evolution_approval_mode: auto` only. The skill knobs do not reach it. |

`--auto-approve` on `ethos eval --evolve` and `ethos evolve` stands in for the global `autoApprove` for that command only (`learningPolicyFor`, `packages/wiring/src/learning-pipeline.ts`).

### When a human decides

Every other candidate waits in `pending_review` (or in `pending_replay`, until something replays it). Every human decision goes through one class, `LearningInbox` (`extensions/learning-inbox/src/inbox.ts`), so whichever surface you decide on, the same rules apply:

| Surface | What you can do there |
|---|---|
| `ethos learning` | Everything: `list`, `show` (evidence, content, scorecard, timeline), `replay`, `approve [--override "<reason>"]`, `reject`, `rollback`. |
| Web dashboard, **Learning** page (`/learning`, `apps/web/src/pages/Learning.tsx`) | Every candidate in one queue, grouped into Needs review, Waiting for replay, Promoted, and Rejected & rolled back. Each shows its evidence, diff, replay scorecard and timeline, with **Approve**, **Approve anyway…**, **Reject…**, **Run replay** and **Rollback**. |
| Web dashboard, **Living Soul** section of a personality | Apply a drafted Expression. |
| `ethos personality evolve <id>` | Answer `y` or `N` on an Expression candidate. `N` rejects it. |
| `ethos evolve apply`, `--approve`, `--reject`, `prune` | Older skill verbs, now adapters onto the inbox. `apply` approves only a `pass`. |

The Learning page is where the web dashboard decides on candidates. The Skills page's **Approval queue** tab approves nothing: it is a link to the Learning page filtered to skills (`/learning?kind=skill`). The Living Soul section's list of waiting changes is a link filtered to that personality (`/learning?personality=<id>`). The **Learning** row in the sidebar's Library section counts candidates waiting in `pending_review`.

Two rules cannot drift between these surfaces:

- **Approving anything that is not a `pass` needs a reason.** That includes a candidate that was never replayed. `LearningInbox.approve` refuses with `override_required` when the reason is blank, and writes the reason to `audit.jsonl` on the promotion line. In the terminal, pass `ethos learning approve <id> --override "<reason>"`. On the web, the Learning page shows **Approve anyway…** in place of **Approve** on any verdict other than `pass`, and its confirm button stays disabled until a reason is typed. Apply in the Living Soul section requires a reason too. At `ethos personality evolve`, answering `y` prompts for a reason, and an empty reason cancels the approval: nothing is promoted and the candidate keeps waiting.
- **Every decision that lands writes one audit row.** `learning.approve`, `learning.override`, `learning.reject` or `learning.rollback` appears in `ethos audit decisions` next to outbox decisions. A refusal writes none.

**Approval is human-only.** The agent's `skills_pending_approve` tool promotes nothing: it returns a refusal that sends the user to the web Learning page or `ethos learning approve <id>` (`SKILL_APPROVAL_IS_HUMAN_ONLY`, `extensions/tools-skills/src/index.ts`). A model approving its own proposal would be a second non-human path, and in `ethos chat` under `approvalMode: off`, where no prompt appears, it would promote with no human at all. `skills_pending_reject` still works, because rejecting only narrows what the agent does.

The `learning.*` RPCs behind the Learning page (`apps/web-api/src/rpc/learning.ts`) accept the dashboard's session cookie only. `learning` is absent from `SCOPE_MAP` in `apps/web-api/src/middleware/dual-auth.ts`, so a bearer API key is refused.

### What promotion checks, and how rollback works

`promote()` (`extensions/learning-inbox/src/promote.ts`) is the one path to a live file, for humans and the resolver alike.

| Kind | On promote | On rollback |
|---|---|---|
| Skill | Refuses invalid frontmatter (status `invalid`). Refuses when the live file no longer hashes to `baseHash` or the destination moved (status `stale`). Snapshots the replaced bytes to `prior.md`, then writes atomically. A `rewrite` replaces its `target_file` rather than adding a new file beside it. | Restores `prior.md`, or removes a file the promotion created. Refuses with `live_edited` when the live file has changed since promotion, so a later hand edit is never clobbered (`checkRollback`). |
| Expression | Refuses when `SOUL.md` changed since the draft. Applies through `evolveExpression`, so the Core stays out of reach and the Learning Log records the revision. | Calls `revertExpression` to the prior snapshot. Allowed only on the personality's most recently promoted Expression candidate (`not_latest` otherwise), because reverting an older one would discard every promotion after it. |

### When replay runs

Replay never runs on `agent_done`. It costs minutes and money, and the end of a user's turn is the wrong place for either. It runs in three places:

| Trigger | Notes |
|---|---|
| The nightly pass's `replay` step, after `skills` | Freezes new cases, then replays `pending_replay` candidates oldest first, capped by `learningReplay.maxCandidatesPerRun` across the whole run (`extensions/nightly-loop/src/orchestrator.ts`). |
| `ethos learning replay <id>`, or **Run replay** on the Learning page | On demand. Both go through `LearningInbox.replay`, which refuses with `replay_unavailable` when `learningReplay.enabled` is false. |
| `--auto-approve` on `ethos eval --evolve` or `ethos evolve` | Replays each new candidate synchronously inside that command. |

The operator settings live in `~/.ethos/config.yaml` (`resolveLearningReplay`, `packages/config/src/index.ts`; full reference at [`learningReplay.*`](../reference/config-yaml.md#learning-replay)):

| Key | Default | Meaning |
|---|---|---|
| `learningReplay.enabled` | `true` | `false` skips the nightly `replay` step and disables on-demand replay |
| `learningReplay.maxCases` | `8` | Cases per candidate; 3 or more, never above 8 |
| `learningReplay.maxCostUsd` | `0.50` | Replay-loop spend per candidate; crossing it stops the run as `incomplete` |
| `learningReplay.maxCandidatesPerRun` | `5` | Candidates one nightly run replays |

## Trade-offs

These are limitations, written down so nobody reads the scorecard as more than it is.

**Replay measures approach, not answers.** Tools are stubbed, so a replay measures tool choice, tool arguments, voice and approach. It cannot tell whether an answer that depends on real tool output got better: a skill that makes the agent read the right file scores well even if what it then says about the file is wrong. Every scorecard prints this caveat (`REPLAY_LIMITATIONS`, `replay.ts`). A `pass` is evidence the change did not make the agent behave worse on familiar tasks, not proof that its answers improved.

**Grader calls are bounded by count, not dollars.** `learningReplay.maxCostUsd` sums the replay loops' `usage` events. `llmJudgeScorer` reports no usage, so grading is capped by `MAX_CRITERIA_PER_CASE` instead: at most 3 criteria × 2 arms × 8 cases = 48 calls per candidate. A case with more criteria is skipped, not partly graded.

**Status changes are check-then-write, not atomic across processes.** Candidates are files through `Storage`, not a transactional store. A human approval and a nightly auto-promotion landing in the same instant can both read `pending_review` and both apply. Both transitions appear in `audit.jsonl`, and rollback stays available.

**A new personality needs recent sessions, not a nightly pass.** Rule (a) needs a regression case. When a replay finds too few in the frozen pool, `replayCandidate` (`extensions/learning-inbox/src/replay.ts`) first freezes regression cases from the personality's recent sessions, through the same `captureCases` path the nightly pass uses, so excluded session keys, the 10-case batch and the 40-case pool cap all apply, and the candidate's target cases are never rewritten or evicted. If there are still too few eligible sessions, the replay is `incomplete` and fails closed. Candidates with no target case stay `incomplete` whatever the pool holds, because nothing backfills a target: a draft from `ethos personality evolve` in `user` mode carries none, and neither does an `auto`-mode draft when the Judge scored no prompt 0.

**Automatic promotions are in `ethos audit decisions`.** When `replayAndResolve` (`extensions/learning-inbox/src/auto-promotion.ts`) promotes a candidate, it writes one `learning.auto_promote` row attributed to the system (`actor: auto`, `decidedBy: system`), carrying the verdict, the replay run id, and the reason: which knob resolved auto and why only the replayed personality can see the destination. A replay that does not promote, or a promotion `promote()` refuses, writes none. The candidate's own `audit.jsonl` still records the promotion too.

**Without the nightly pass, candidates wait.** `nightlyPass.enabled` defaults to false (the `nightly-pass` job in `packages/wiring/src/system-jobs.ts`). On an install that has not turned it on, nothing replays on a schedule, and every candidate waits for an on-demand replay (`ethos learning replay <id>`, or **Run replay** on the Learning page), `ethos nightly run`, or a human approval with a reason. With `autoApprove` on, a fork's skill now waits for that replay instead of going live instantly.

**The overlay compares paths lexically.** `OverlayStorage` shadows a destination under the name it was given, not its symlink target, and it synthesizes the shadowed file but never a missing parent directory.

## See also

- [`ethos learning` CLI reference](../reference/cli.md#ethos-learning) — `list`, `show`, `replay`, `approve`, `reject`, `rollback`.
- [Why skills, separate from tools and personalities?](what-is-a-skill.md) — what a skill is and how the evolver drafts one.
- [What is dreaming, and why does an agent need idle time?](dreaming.md) — the other thing a personality does while you are away.
- [Approve posts before sending](../how-to/approve-posts-before-sending.md) — the outbox, whose decisions share `ethos audit decisions` with learning.
- [Glossary: skill evolution](../../getting-started/glossary.md#skill-evolution)
