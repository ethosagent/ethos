---
title: "Why is the initiative engine read-only, and what does it cost?"
description: "How initiatives research on a schedule without changing anything, which layers enforce that, how the day's budget is split, and the limits left open."
kind: explanation
audience: user
slug: initiatives
updated: 2026-11-28
---

## Context

Tell a [personality](../../getting-started/glossary.md#personality) (a directory of files that decides the agent's tools, memory, and model) "keep an eye on why signups stall" and it can do that work while you sleep. An **initiative** is that standing brief: an outcome, the sources it may read, a budget and a schedule. The engine runs short read-only windows against it, records findings in its own ledger, and sends you a morning digest of what needs a yes.

The hard question is trust. Research that runs unattended must not post, send, write files or spend without a cap. The engine answers with one rule that no config key can loosen: it reads, and it writes only its own ledger (`initiatives.db`) and its own `initiatives/*.yaml`. Acting on a finding is your step, outside the engine.

## Discussion

### The loop in one pass

A **survey** reads the initiative and proposes explorations (questions worth digging into). Gate 1 is your decision on a proposal: approve, reject or snooze. Under `autonomy.mode: free_under`, a proposal at or below `ask_above_usd` starts without asking (`decideAutonomy` in `extensions/initiative-runner/src/autonomy.ts`). An approved exploration gets **windows**, bounded runs that record findings, each with a source reference. A window ends in a brief. Gate 2 is your decision on a brief: adopt, dig deeper or park.

Agent-started initiatives follow the same rules. With `selfStart` on, a daily **scan** may draft a new initiative. You keep it, make it yours or stop it.

### Why read-only holds

Each layer is enforced by named code and pinned by a test. No layer is a prompt instruction.

| Layer | Guarantee | Enforcer | Pinned by |
|---|---|---|---|
| L1 | A run sees a fixed read allowlist; config can only remove entries | `INITIATIVE_READ_TOOLS`, `runToolNames` | `initiative-allowlist.test.ts` |
| L2 | A run builds a fresh registry, so no `alwaysInclude` tool leaks in | `buildReadOnlyRegistry` | `initiative-always-include.test.ts` |
| L3 | A tool that declares a write, a process, storage or MCP origin stops the run before it starts | `assertReadOnlyCapabilities` | `initiative-capability-audit.test.ts` |
| L4 | A blocked call never executes, yet a `tool_result` is still stored | `createInitiativeToolGate` | `initiative-blocked-call.test.ts` |
| L5 | A run has no session database, no memory flush and no compaction | `ReadOnlyLoopParts`, `readOnlyRunOptions` | `initiative-ctx.test.ts` |
| L6 | Network reads are GET-only behind the SSRF floor | `web_extract`, `checkSsrf` | `initiative-network.test.ts` |
| L7 | Every tool name is classified read, ledger, chat or never | `INITIATIVE_NEVER_TOOLS` | `initiative-readonly-census.test.ts` |
| L8 | An unknown key such as `allowWrites` fails validation | `InitiativeFileSchema`, `InitiativeSettingsSchema` (`.strict()`) | `initiative-config.test.ts`, `initiatives-block.test.ts` |
| L9 | Only the ledger changes (the test uses an in-memory ledger fake, not the SQLite file) | file-hash diff of a temp home | `initiative-no-writes.e2e.test.ts` |
| L10 | Sources and budgets are checked before any save | `InitiativeConfigService`, `checkSources` | `initiative-sources-roots.test.ts`, `initiative-draft-no-widen.test.ts`, `initiative-define-scope.test.ts` |

Three decisions follow from the layers. No decision row can come from a tool: only `SQLiteInitiativeStore.recordDecision`, reached through `decideInitiative` in `packages/wiring/src/initiative-decide.ts`, writes one, and only the CLI, the web app and channel taps call it. The digest recipient comes from `delivery.ownerChannel`, never from model output. A run executes as a private, incognito turn.

### What it costs

Nothing until you save an initiative with a budget. `usd_per_day` is then clamped to the smallest of the operator ceilings and the personality's `dailyBudgetUsd` (`clampInitiativeBudgets`, `extensions/constitution/src/index.ts`). Inside a day, `planDay` splits money across windows. The formula and an example are in [Initiative budget and delivery](../reference/initiatives-budget-and-delivery.md#budget-formula). It differs from the flat per-window figure in the original design page.

A window aborts when the day or exploration cap has less than $0.05 left (`PER_CALL_RESERVE_USD`, `createWindowGuard`). The in-flight call still finishes, so overshoot is at most one call.

### Switching it off

`initiatives.enabled: false` in `constitution.yaml` stops every run at the next tick (`effectiveEnabled` in `config-schema.ts`). Files and ledger stay. A personality with `enabled: false` in its own `settings.yaml` stops alone. An invalid `settings.yaml` pauses that personality and says why.

## Trade-offs

These are limits, not guarantees. Each has no enforcer unless one is named.

| Limit | Detail |
|---|---|
| Per-call tools are unmetered | Only model `usage` events count toward the window guard. Tools that bill per call (`engine_ask`, `x_search`, search providers) report no cost, so their spend is not charged to the window or the day. The loop's per-turn tool budget bounds calls, not dollars. |
| Cross-process cap race | The keyed lock in `day-caps.ts` is per process. A CLI `run` beside `ethos serve` can read the same remaining money. Overshoot is bounded by one run's cap. |
| Declared secrets are allowed | Any exact secret reference a read tool declares in `capabilities.secrets` is allowed to it. Nothing checks that the tool uses it for its own provider. |
| Self-started resumes as active | After a switch-off and back on, a self-started initiative returns as `active`, because `paused` to `self_started` is not an allowed move. |
| Stopped-topic match is narrow | A draft is refused as a repeat of a stopped initiative only by id or by identical normalised title. A reworded draft passes. |
| Lexical path checks | `checkSources` folds `~` and `..` but does not resolve symlinks. A symlink inside a readable root that points outside it is not caught. |
| Shallow history | `initiatives.get` returns only the current version in `versions`. |
| Digest has no buttons | The digest goes out as text through `notifyTracked`, which has no blocks path. The button builders (`digestCard`, `digestBlocks`) exist, but nothing in the repo sends them. Taps work only on cards sent by something else. Each digest line carries the CLI command instead. |
| Taps leave the message alone | A tap records the decision and answers. It does not edit the original message to remove its buttons. |
| TUI strip follows one personality | The "exploring now" strip shows the personality the TUI launched with. `/personality` switches are not followed. |
| GET side effects | A GET can unsubscribe or trigger a magic link on a badly built site. |
| Search egress | Queries go to search providers, and a fetch tells a site it was visited. `sources` limits what a run reads, not what it searches for. |
| Prompt injection | Web results are `outputIsUntrusted` and wrapped. If an instruction slips through, a run still has no write tool and no config tool. |
| L3 is partial | A tool that writes through an injected service declares `{}`. L1, L4 and L7 carry those tools. |
| Local shell in chat | A personality with a shell tool can write `initiatives/` directly, as with every definition file. The service re-validates on load. |
| MCP servers | The operator names them, so the census cannot classify them. They never enter a run registry (L2, L3). |
| Unknown constitution keys | Unknown top-level keys are ignored. Unknown keys inside `initiatives` are rejected. |
| In-process write lock | `InitiativesService` serialises writes in one process. A CLI or hand edit in another process between its read and write goes undetected. |

## See also

- [Initiative config reference](../reference/initiatives-config.md) — every YAML key, setting and ceiling, and where each is edited.
- [Initiative budget and delivery](../reference/initiatives-budget-and-delivery.md) — the day budget formula, the digest and channel taps.
- [CLI: ethos initiatives](../reference/cli/initiatives.md) — every subcommand and flag.
- [Initiatives RPC reference](../../building/reference/initiatives-rpc.md) — the web API behind the Initiatives page.
- [`@ethosagent/tools-initiatives`](https://github.com/ethosagent/ethos/blob/main/extensions/tools-initiatives/README.md) — the tools a chat and a run can call.
