# @ethosagent/tools-skills

## Purpose

Skill tools: `skills_list` and `skill_view` for the skill pool, plus `skills_pending_list`, `skills_pending_view`, `skills_pending_approve` and `skills_pending_reject` for proposed skills. Approval is a human decision, so the approve tool only returns instructions for the human paths. The pending queue is an injected port.

## Public surface

Exported from `src/index.ts`, plus subpath `./compose` (`compose`, `SkillsToolsCompose`), a `WiringContext` entry point that builds the tools from the skill pool.

| Export | Kind | One line |
|---|---|---|
| `createSkillsTools` | function | Returns the six skill tools. |
| `SkillsToolsOptions` | interface | Skill list and content readers, pending port. |
| `PendingSkillsPort` | interface | List and reject proposed skills. |
| `PendingSkillSummary` | interface | One queue entry. |
| `SkillEntry` | interface | One pool entry for `skills_list`. |
| `SKILL_APPROVAL_IS_HUMAN_ONLY` | const | The text `skills_pending_approve` answers with. |

## Seam

Implements `Tool` from `@ethosagent/types`; `compose` takes a `WiringContext` and the `Skill` pool. Archcheck layer: `extensions` (rule `extensions-implement-contracts` in `architecture.config.ts`). Rule `tools-read-env-through-ctx` bans `process.env` in `extensions/tools-*/src/**`, so config arrives through `ctx.*`. Tool conventions: `.claude/rules/providers-and-tools.md`.

## Testing

```
pnpm vitest run extensions/tools-skills
```

Pinning test: `src/__tests__/pending.test.ts` holds that `skills_pending_approve` refuses and names both human paths, promotes nothing for queued, unknown or unsafe ids, that invalid ids are refused by the pending tools, that approve and reject carry `requiresApproval`, and that read-only pending tools do not.
