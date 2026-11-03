# @ethosagent/constitution

## Purpose

Loader and enforcer for the operator constitution, the host operator's ceiling over every personality. It reads `constitution.yaml` from the Ethos home through `Storage`, validates it field by field, and at wiring time either throws on a violating personality or clamps its budget. Wiring decides when to call it; the personalities and the `Constitution` type live elsewhere.

## Public surface

Single entry point, `src/index.ts` (the only `exports` key in `package.json` is `.`).

| Export | Kind | One line |
|---|---|---|
| `loadConstitution` | function | Reads and validates `constitution.yaml`; returns a status of `missing`, `loaded` or `malformed`. |
| `enforceConstitution` | function | Checks every personality against the constitution and returns the budget clamps applied. |
| `EnforceArgs` | interface | Arguments for `enforceConstitution`. |
| `applySafeMode` | function | Restricts non-builtin personalities to the read-only toolset. |
| `SAFE_MODE_READONLY_TOOLS` | const | Tool names allowed in safe mode. |
| `BUILTIN_PERSONALITY_IDS` | const | Ids exempt from safe-mode stripping. |
| `isReachWithinAllowedRoots` | function | Backstop check that an `fs_reach` path sits inside the allowed mount roots. |
| `ConstitutionViolationError` | class | Re-exported from `@ethosagent/types`. |
| `PERMISSIVE_DEFAULT_CONSTITUTION` | const | Re-exported from `@ethosagent/types`; used when the file is missing. |

## Seam

Operates on the `Constitution`, `PersonalityConfig` and `Storage` contracts from `@ethosagent/types`; it imports `@ethosagent/types` and `yaml` only and replicates two small helpers from core to keep the `types <- core <- extensions` direction (comment at the top of `src/index.ts`). Archcheck layer: `extensions`. The rationale is ARCHITECTURE.md section V (Safety Constitution); the safe-mode runbook is `docs/content/using/how-to/safe-mode.md`.

Pinned in `src/__tests__/constitution.test.ts`: a forbidden tool, an `fs_reach` escaping `allowedMountRoots`, a denied path prefix, forbidden local execution and a network host rule each throw; a budget above the ceiling is clamped, and the clamp drives a real `AgentLoop` refusal.

## Testing

```
pnpm vitest run extensions/constitution
```

Pinning tests: `src/__tests__/constitution.test.ts` holds the budget clamp, forbidden tools, `fs_reach` bounds, denied prefixes, execution posture, network rules, load results (`missing` returns the permissive default, `malformed` triggers safe mode) and the safe-mode toolset.
