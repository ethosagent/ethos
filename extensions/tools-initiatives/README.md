# @ethosagent/tools-initiatives

The tools of the initiative engine: the ones you talk to in chat to set up a standing research brief, and the ones a read-only research run uses to record what it finds. A run can look things up and write to its own ledger. It cannot post, send, change a file or spend past a cap, and nothing here can loosen that.

This package is only the tools. The read-only enforcement lives in [`initiative-runner`](../initiative-runner), the ledger in [`initiative-store`](../initiative-store). Read the [explanation page](../../docs/content/using/explanation/initiatives.md) first for the model.

## Tools

Every tool has `toolset: 'initiative'`, `capabilities: {}` and reaches state only through a narrow port from `@ethosagent/types`. The class names come from `INITIATIVE_CHAT_TOOLS` and `INITIATIVE_LEDGER_TOOLS` in `extensions/initiative-runner/src/tool-classes.ts`.

| Tool | Surface | Port | What it does |
|---|---|---|---|
| `initiative_define` | chat | `InitiativeConfigPort` | Creates, updates, pauses, resumes or ends an initiative after the owner's yes. Refuses `create`, and any change to `budget`, `sources` or `autonomy`, until `confirmed: true`. |
| `initiative_add_ideas` | chat | `InitiativeLedgerPort` | Records the owner's ideas and guidance notes for an initiative this personality owns. |
| `initiative_list`, `initiative_search`, `initiative_get` | chat and run | `InitiativeRecallPort` | Read the ledger, scoped to one personality. Every claim prints its finding id so it can be cited. |
| `initiative_propose` | run | `InitiativeLedgerPort` | Proposes an exploration for the owner to approve, or a draft new initiative. Nothing starts without a decision. |
| `initiative_note` | run | `InitiativeLedgerPort` | Records one finding. `source_ref` is required. Only for the window's own exploration. |
| `initiative_brief` | run | `InitiativeLedgerPort` | Submits the brief: options, evidence, cost, risk, recommendation. `partial: true` when the window ended early. |
| `initiative_ideas`, `initiative_budget` | run | `InitiativeLedgerPort` | List this initiative's ideas. Report today's spend, cap and open explorations. |
| `clarify` | run | `InitiativeLedgerPort` | Stores a question for the next digest. It does not wait for an answer. |

Chat tools are `alwaysInclude` and private-chat only: a call in a shared room is refused with `the initiative ledger is not shown in shared rooms`. A personality's own toolset cannot hide them. They are hidden when the engine is switched off for that personality.

Run tools are bound to one initiative id and, for `initiative_note` and `initiative_brief`, to one exploration id. A call naming another is refused. Recall output is `outputIsUntrusted`, because findings quote web pages.

## Read-only posture

- **No decision tool.** No tool here writes a `decisions` row. `SQLiteInitiativeStore.recordDecision` is reached only through `decideInitiative` in `packages/wiring/src/initiative-decide.ts`, which the CLI, the web app and owner taps call.
- **No config tool in a run.** `initiative_define` is chat only. A run saves a new-initiative idea as a draft row through `initiative_propose`. `InitiativeConfigService` validates it afterwards.
- **A run's tool list is fixed.** `runToolNames` in `tool-classes.ts` intersects a read allowlist with the personality's toolset and adds the ledger tools. `buildReadOnlyRegistry` (`packages/wiring/src/initiatives.ts`) builds a fresh registry from it.
- **Enforcers.** `assertReadOnlyCapabilities` refuses to start a run with a tool that declares a write, a process, storage or an MCP origin. `createInitiativeToolGate` blocks any call outside the list yet still stores a `tool_result`. Tests: `initiative-allowlist.test.ts`, `initiative-capability-audit.test.ts`, `initiative-blocked-call.test.ts`, `initiative-readonly-census.test.ts`.
- **Limit.** A tool that writes through an injected service declares `{}`, so the capability audit cannot see it. The allowlist, the gate and the census carry those tools.

## Public surface

Exported from `src/index.ts`.

| Export | Kind | One line |
|---|---|---|
| `createInitiativeChatTools(deps)` | function | `initiative_define` and `initiative_add_ideas`. |
| `createChatInitiativeRecallTools(port)` | function | The three recall tools for chat, scoped by `ctx.personalityId`. |
| `createInitiativeRecallTools(port, personalityId, opts?)` | function | The recall tools bound to one personality. `surface: 'run'` is passed only by the run registry. |
| `createInitiativeLedgerTools(port, initiativeId, explorationId?)` | function | `initiative_propose`, `_note`, `_brief`, `_ideas` and `_budget`. |
| `createRunClarifyTool(port, initiativeId)` | function | The run-local `clarify`. |

## Seam

Implements `Tool` from `@ethosagent/types` and depends on `@ethosagent/types` only, never on `initiative-store`. Composed in `packages/wiring/src/compose-initiatives.ts` (chat) and `packages/wiring/src/initiatives.ts` (runs). Archcheck layer: `extensions`. Tool conventions: `.claude/rules/providers-and-tools.md`.

## Testing

```
pnpm vitest run extensions/tools-initiatives
```
