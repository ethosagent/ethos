---
name: dependency-analyzer
description: |
  Detect new imports introduced by uncommitted changes and flag unintended cross-layer
  coupling. Per ARCHITECTURE.md the layer model is types ← core ← extensions ← apps —
  imports must only flow toward types. Use when adding any cross-package import, before
  invoking /openai-reviewer, or when the user asks "what does this depend on" or
  "did I introduce coupling". Returns {new_imports: [...], violations: [...]}. Read-only.
allowed-tools: Bash(dep-analyze *), Bash(*/dep-analyze *), Bash(git diff*), Bash(rg*)
---

# Dependency Analyzer

Greps `git diff` for new `import` lines, classifies the importer and the imported module by layer, and flags any cross-layer import that violates the project's dependency direction.

## The layer rule

From [ARCHITECTURE.md](../../../ARCHITECTURE.md):

```
types  ←  core  ←  extensions  ←  apps
```

Anyone can import from `@ethosagent/types` (zero-dep contracts). Nothing should import upward — `core` does not import `extensions`, `extensions` do not import `apps`. Imports across siblings at the same layer (e.g. `extension A → extension B`) are also a smell — extensions should compose via the contracts in `types`, not depend on each other.

## Usage

```bash
.agents/skills/dependency-analyzer/scripts/dep-analyze
```

No arguments — analyses uncommitted + staged changes against `HEAD`.

## Output shape

```json
{
  "new_imports": [
    {
      "file": "packages/core/src/agent-loop.ts",
      "importer_layer": "core",
      "module": "@ethosagent/llm-anthropic",
      "module_layer": "extensions"
    }
  ],
  "violations": [
    {
      "file": "packages/core/src/agent-loop.ts",
      "importer_layer": "core",
      "module": "@ethosagent/llm-anthropic",
      "module_layer": "extensions",
      "rule": "core must not import from extensions"
    }
  ],
  "verdict": "violations_found"
}
```

`verdict` is `"clean"`, `"violations_found"`, or `"unchanged"` (no new imports).

## When to use

- Adding a workspace dependency, especially one that crosses layers.
- Adding any `import` from a different package than the one you're editing.
- Before invoking `/openai-reviewer` on a non-trivial diff — a clean dependency report makes the review focused on logic, not coupling concerns.
- When the user asks "what does this depend on now", "did I introduce coupling", "any new imports".

## When NOT to use

- For checking type-level imports (`import type { ... }`) only — those don't create runtime coupling, the script still flags them but treat as informational.
- As a substitute for the constitution validator in `pnpm check` — that runs against more than just imports.

## Acting on violations

Per [CLAUDE.md](../../../CLAUDE.md) Rule 7: if the violation is intentional (e.g. wiring layer pulling extensions to compose them), open a constitutional amendment per ARCHITECTURE.md §VI. Otherwise refactor — pull the shared piece into `@ethosagent/types` or invert the dependency.

## Read-only

Reads `git diff` and the filesystem only. Does not modify code.
