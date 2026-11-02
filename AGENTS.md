# Ethos

Ethos is a TypeScript agent framework where personality (SOUL.md + toolset.yaml + config.yaml) is architecture, not a prompt string.
Node 24, TypeScript 6 strict, pnpm, Biome 2, vitest, tsx in dev.

## Behavioural rules

1. Think before coding: state assumptions, surface tradeoffs, ask when unclear.
2. Simplicity first: minimum code, nothing speculative.
3. Surgical changes: touch only what you must, match existing style.
4. Goal-driven: write the test first; run `pnpm check` before done and `pnpm lint` before pushing.
5. Surface conflicts, don't average them: pick one pattern, explain why, flag the other.
6. Ask before adding to code you don't understand.
7. Follow the constitution ([ARCHITECTURE.md](./ARCHITECTURE.md), enforced by `architecture.config.ts`). Read it before: adding or moving a package, extension or app; adding a cross-layer workspace dependency; changing a `packages/types/` contract; touching a `safety-*` module; modifying a frozen schema; raw `node:fs` in a personality boundary; `console.*` in library code. Refactor to fit or open an amendment (§VI).
8. Git safety: never commit to main unconfirmed; confirm each destructive git operation separately.
9. Plan vs implementation: revising a plan means editing ONLY the plan file; wait for "now implement". `plan/` is gitignored, no worktrees.
10. Verify before claiming: re-run `pnpm test && pnpm typecheck && pnpm lint`; check each sub-agent-claimed bug against source.
11. Main session orchestrates; sub-agents execute. The main session does not write or edit files. Every code or doc change — even a one-line typo, a single-file rename, a single-language tweak — is delegated to a sub-agent via the Agent tool. Read-only inspection and verification stay here; AGENTS.md, CLAUDE.md and other agent-rule files may be edited here.
12. Cite what enforces a guarantee. A comment or doc sentence asserting a guarantee — "X is refused", "Y is validated", "Z never happens" — names the file and symbol that enforces it, or the test that pins it. No enforcer you can name means write it down as a limitation.

## Packages

Layer names are archcheck's.

- `packages/types` zero-dep contracts, frozen schemas → `contracts`
- `packages/core` AgentLoop, registries, scoped fs → `core`
- `packages/wiring` composition root (`createAgentLoop`, backup, locks) → `wiring`
- `packages/storage-fs`, `packages/safety/*` Storage impls, safety-* → `security-kernel`
- `packages/config`, `packages/web-contracts`, `packages/sqlite` (`vendored` shim)
- `extensions/llm-*`, `memory-*`, `tools-*`, `execution-*` providers, backends, toolsets → `extensions`
- `extensions/platform-*` + `extensions/gateway` channel adapters; gateway owns dedup, ledger, spool
- SQLite stores: `session-sqlite`, `job-store`, `delivery-ledger`, `inbound-spool`, `notify-queue`
- `extensions/personalities` registry + built-ins
- `apps/*` ethos (CLI), web-api, web, desktop, tui, mcp-server, acp-server → `app-entry`

## Commands

```
make prepare                          # pnpm install
pnpm dev                              # chat
pnpm check                            # typecheck + lint + test
pnpm test | typecheck | lint | lint:fix
pnpm arch                             # archcheck
bash scripts/run-checks.sh            # quiet, failures only
node scripts/check-agent-files.mjs    # agent-file size gate
```

## Dependency law

Allowed: `types ← core ← extensions ← apps`; `packages/wiring` is the only composition root.
Forbidden: upward imports, core importing implementations, extensions importing wiring. Enforced by the layer rules in `architecture.config.ts` and `scripts/check-tool-imports.sh`; `pnpm exec archcheck explain <ruleId>` gives the remedy.

## Architecture checks (archcheck)

ARCHITECTURE.md says why each law exists; `architecture.config.ts` is the enforced projection — the layer table, banned constructs (console in libraries, `process.env` in tools, computed `import()`, empty catch, `new FsStorage` in libraries, raw `Error` in CLI commands) and their exceptions. archcheck checks it at pre-commit (`archcheck --changed`), pre-push (`archcheck`, `archcheck emit --check`, `node scripts/check-archcheck-baseline.mjs`), in `pnpm test` (`packages/types/src/__tests__/archcheck.test.ts`, `archcheck-fixtures.test.ts`) and in CI's `architecture` job. Pre-existing violations live in `.archcheck/baseline.json`, which only shrinks. `scripts/check-architecture.mjs` still checks tiers, the guarantee register, register claims, sidecar exceptions and stale paths — NOT layers.

What to do per `pnpm arch` exit code:
- 1 — a new violation. Fix the code using the finding's remedy (`pnpm exec archcheck explain <ruleId>`). If the rule looks wrong for this case, STOP and raise a request to the maintainer with the rule id, the file, and the proposed manifest diff (a rule change or an exception with owner, expiry, reason, removal condition) — never apply it yourself.
- 2 — the manifest or environment is broken (includes an expired exception). Stop and report; do not touch code or the manifest.
- 3 — emitted output is stale. Run `pnpm arch:emit` and commit the regenerated ARCHITECTURE.md table and `.archcheck/generated/`.
- 4 — a baselined violation was fixed. Run `pnpm arch:prune` and commit the smaller baseline.

Protected paths — changes need the maintainer's approval, and the Claude guard hook (`scripts/guard-architecture.sh`) blocks agent edits to them: `architecture.config.ts`, `.archcheck/baseline.json`, `archcheck-fixtures/`, `packages/types/src/__tests__/archcheck.test.ts`, `packages/types/src/__tests__/archcheck-fixtures.test.ts`, `scripts/check-archcheck-baseline.mjs`, `scripts/guard-architecture.sh`, `.claude/settings.json` (the hook's own registration). The hook also refuses `baseline --write`, `--no-verify`, `LEFTHOOK=0`, `SKIP_PUSH_HOOK=1` and `Architecture-Approved-By` in shell commands — that trailer is the maintainer's to add, not an agent's.

## Non-negotiables

- Storage only, no raw `node:fs` for `~/.ethos/` → `apps/ethos/src/__tests__/no-raw-fs.test.ts`.
- No `console.*` in libraries → archcheck `l10-silent-libraries`.
- Extensionless imports (`./foo`), the one hard rule.
- Frozen schemas change only through their drift gates → ARCHITECTURE.md §VII.
- Drain `AgentLoop.run()` to exhaustion → `extensions/gateway/src/__tests__/turn-tail.test.ts`.
- Single owners, never a second writer → `.claude/rules/agent-loop.md`.
- Every `AgentLoop.run` passes `roomAudience` → `packages/core/src/__tests__/audience-census.test.ts`.
- Static-first prompt → `packages/core/src/__tests__/prompt-prefix-stability.test.ts`.

## Where new code goes

| New | Where | Rule file |
|---|---|---|
| LLM provider | `extensions/llm-<name>/`, wire in `packages/wiring` | providers-and-tools |
| Tool | `extensions/tools-*` | providers-and-tools |
| Memory backend | `extensions/memory-<name>/` | memory-tools |
| Channel adapter | `extensions/platform-<name>/` | gateway-dedup |
| Personality | `~/.ethos/personalities/<id>/` | personality |
| CLI command | `apps/ethos/src/commands/` | storage |
| SQLite store | `extensions/<name>/` | sqlite-durability |
| Web RPC | `packages/web-contracts` + `apps/web-api/src/rpc` | ui-design |

## Gotchas

- Node 24 before any `pnpm`; vitest is 5.0.1, not 4.
- Claude Code reads CLAUDE.md, not AGENTS.md, when both exist; here CLAUDE.md is a symlink to AGENTS.md, so edit AGENTS.md and keep the link.
- SQLite: STRICT tables, `rowid` is not in `SELECT *`, tie-break on `rowid`.
- `getMessages({ limit })` returns the newest N.
- A blocked `before_tool_call` must skip execution yet still persist a `tool_result`.
- Anthropic cache tokens are in `message_start`; thinking params need the `any` cast.
- OpenAI tool-call deltas key by index, not id.
- `openai`'s zod v3 peer warning is ignored on purpose.
- Biome v2: `!dist/` needs a trailing slash.
- Never cast API responses with `as`; use oRPC types or Zod `.safeParse()`.

## Deeper docs

`.claude/rules/*.md` load by path.

| File | Read when |
|---|---|
| agent-loop | AgentLoop, hooks, events, single owners |
| gateway-dedup, gateway-delivery-ledger, gateway-inbound-spool, gateway-audience-multibot | adapters, lost or double replies, replay, shared rooms |
| memory, memory-tools | memory scopes, memory tools, new backend |
| personality | personalities, `PersonalityConfig` limits |
| providers-and-tools | new provider or tool, result budget |
| storage | Storage, ScopedStorage, atomic writes |
| fs-carveouts-containment, -host, -locks, -sqlite | raw `node:fs` outside Storage |
| sqlite-durability, sqlite-gotchas | `synchronous` choice, STRICT/FTS5 |
| tool-progress-audience | `ctx.emit` progress |
| toolchain-gotchas | package.json, Biome, tsx |
| ui-design | any UI decision (also DESIGN.md) |

Also ARCHITECTURE.md, DESIGN.md, TESTING.md, `.agents/skills/docs/SKILL.md`, `docs/content/building/reference/storage-interface.md`.

## Moved sections

Source comments cite `CLAUDE.md, "<old heading>"`; files in `.claude/rules/`.

- "Hook registry", "AgentEvent types", "Single-owner contracts" → agent-loop.md
- "Tool-progress audience boundary" → tool-progress-audience.md
- "Channel adapter contract" → gateway-*.md
- "Storage abstraction" → storage.md + fs-carveouts-*.md
- "SQLite durability posture", "Session key convention" → sqlite-durability.md, sqlite-gotchas.md
- "Adding a new LLM provider/tool" → providers-and-tools.md
- "Adding a personality", "What does NOT belong on PersonalityConfig" → personality.md
- "Memory", "Memory tool reference" → memory.md, memory-tools.md
- "Design system" → ui-design.md; "Learnings" → toolchain-gotchas.md
- "Monorepo layout", "Key files", "Core design principles" → dropped

# Compact instructions

On compaction keep: the active plan path and task number; the failing gate and its `.logs/` path; files touched; open decisions.
Drop tool output bodies.
