# @ethosagent/recipes

## Purpose

One-click use-case bundles. A recipe is declarative data (personality, toolset, cron jobs, required inputs and secrets), and this package holds the Zod bundle schema, the `{{input.*}}` templater, preflight over an injected world snapshot, and the built-in bundles. Every function is pure; installing anything is left to the app layer, so nothing here writes.

## Public surface

Single entry point `.` (`src/index.ts`), 5 built-in bundles plus schema, template and preflight functions. Main entry points below; the `Recipe*` bundle and personality type variants are also exported.

| Export | Kind | One line |
|---|---|---|
| `RECIPES` | const | The shipped bundle list. |
| `morningBriefing` | const | Built-in bundle. |
| `webWatchdog` | const | Built-in bundle. |
| `linkArchiver` | const | Built-in bundle. |
| `heartbeat` | const | Built-in bundle. |
| `obsidianSecondBrain` | const | Built-in bundle offered in create and attach modes. |
| `RecipeBundleSchema` | const | Zod schema a bundle must parse against. |
| `RecipeBundle` | type | Bundle type derived from the schema. |
| `RecipeInstallMode` | type | `create` or `attach`. |
| `resolveInstallMode` | function | Picks the install mode for a bundle. |
| `projectBundle` | function | Projects a bundle onto one install mode. |
| `projectPersonality` | function | Projects the personality block onto one install mode. |
| `defaultRecipeSafety` | function | Default network allow-list for a bundle. |
| `INPUT_PLACEHOLDER_PATTERN` | const | The one supported `{{input.<key>}}` form. |
| `RECIPE_INPUT_KINDS` | const | Allowed input kinds. |
| `placeholderKeys` | function | Keys used in a text, first-seen order. |
| `unresolvedPlaceholders` | function | Keys still without a value. |
| `renderTemplate` | function | Substitutes values; throws on a missing one. |
| `renderTemplatePreview` | function | Renders with unresolved keys left visible. |
| `resolveInputs` | function | Applies defaults and reports missing required inputs. |
| `renderRecipe` | function | Renders a bundle into a `ResolvedRecipe`. |
| `RecipeTemplateError` | class | Error raised by the templater. |
| `appendRecipeSoulSection` | function | Appends a marked recipe section to SOUL.md. |
| `preflightRecipe` | function | Reports blockers, needed inputs and warnings for a world snapshot. |
| `unknownToolNames` | function | Tool names in a bundle not in a known set. |

## Seam

Layer `extensions`. Depends on `@ethosagent/types` for `ModelTierConfig` only (`src/schema.ts`); the schema annotation ties the two. Tool names in every bundle view are pinned against the real tool sources by `src/__tests__/toolset-names.test.ts`.

## Testing

```
pnpm vitest run extensions/recipes
```

- `src/__tests__/bundles.test.ts`: unique ids, every bundle parses, MCP and plugin lists agree, tool names match across views.
- `src/__tests__/data.test.ts`: the shipped bundles and the obsidian create and attach views.
- `src/__tests__/preflight.test.ts`: satisfied world has no blockers, missing inputs and secrets are reported.
- `src/__tests__/template.test.ts`: placeholder discovery, missing value throws, blank counts as unresolved.
- `src/__tests__/toolset-names.test.ts`: each bundle names only tools that exist.
