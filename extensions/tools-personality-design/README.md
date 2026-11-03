# @ethosagent/tools-personality-design

## Purpose

Tools that let an agent design new personalities and teams: list tools, models and skills, scaffold a personality, list team patterns, scaffold a team, and propose a self-amendment. Writes go through injected `Storage`; the package creates new personalities only and does not edit existing ones.

## Public surface

Exported from `src/index.ts`, plus subpath `./compose` (`compose`, `PersonalityDesignToolsCompose`), a `WiringContext` entry point.

| Export | Kind | One line |
|---|---|---|
| `createPersonalityDesignTools` | function | Personality tools (`list_available_tools`, `list_available_models`, `list_available_skills`, `scaffold_personality`, `list_personalities`). |
| `createTeamDesignTools` | function | Team tools (`list_team_patterns`, `scaffold_team`). |
| `createAllDesignTools` | function | Both sets. |
| `createProposeSelfAmendmentTool` | function | Builds `propose_self_amendment` around an optional submit port. |
| `PROPOSE_SELF_AMENDMENT_TOOL` | const | Tool name. |
| `PROPOSE_AMENDMENT_LIMITS` | const | Size limits on a proposal. |
| `PersonalityDesignDeps` | interface | Registries, model catalog, storage and data dir for personality tools. |
| `TeamDesignDeps` | interface | Dependencies for team tools. |
| `AllDesignDeps` | type | Intersection of both. |
| `ModelCatalogEntry` | interface | One entry of the model catalog. |

## Seam

Implements `Tool` from `@ethosagent/types`; uses `Storage`, `PersonalityRegistry`, `ToolRegistry` and `TeamManifest`. Archcheck layer: `extensions` (rule `extensions-implement-contracts` in `architecture.config.ts`). Rule `tools-read-env-through-ctx` bans `process.env` in `extensions/tools-*/src/**`, so config arrives through `ctx.*`. Tool conventions: `.claude/rules/providers-and-tools.md`.

## Testing

```
pnpm vitest run extensions/tools-personality-design
```

Pinning tests in `src/__tests__/`: `src/__tests__/no-overwrite.test.ts` (refuses an existing user id, a built-in id and case-insensitive matches; writes under the injected data dir), `src/__tests__/scaffold.test.ts` (refuses the running personality's id and an existing `config.yaml`), `src/__tests__/untrusted-taint.test.ts` (`scaffold_personality` and `scaffold_team` are refused after an untrusted read and write nothing), `src/__tests__/propose-amendment.test.ts` (schema, unavailable without a port, refusal and dedupe reporting), `src/__tests__/personality-design-tools.test.ts` (list tools).
