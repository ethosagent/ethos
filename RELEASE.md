# Releasing Ethos

> **Channel in scope: npm only.** Docker, Homebrew, and single-binary distribution are not in scope — revisit when there is customer demand.

## Version source of truth

**`VERSION`** (at the repo root) is the single source of truth. Every `package.json` version field, the binary's `ethos --version` output, and the git tag must all match it.

```
ethos/
├── VERSION                       ← source of truth: just "1.0.0\n"
├── apps/ethos/package.json       ← version field MUST match VERSION
├── packages/*/package.json       ← all match VERSION
└── extensions/*/package.json     ← all match VERSION
```

**Never edit `package.json` versions directly.** Use `make version-set` or `make version-bump-*`. Running any other tool that touches `version` fields will cause CI to fail on the G1 gate.

## What gets published

Five packages publish in lockstep (all at the same version):

| Package | Source | Audience |
|---|---|---|
| `@ethosagent/cli` | `apps/ethos/` | end users — the `ethos` binary |
| `@ethosagent/types` | `packages/types/` | plugin authors — interface contracts |
| `@ethosagent/core` | `packages/core/` | plugin authors + advanced embedders |
| `@ethosagent/plugin-sdk` | `packages/plugin-sdk/` | plugin authors |
| `@ethosagent/plugin-contract` | `packages/plugin-contract/` | marketplace + plugin authors |

Everything else (`extensions/*`, `apps/{tui,vscode-extension,web}`, `packages/agent-bridge`, etc.) is `"private": true` and bundled into the CLI at build time.

## Prerequisites — first time only

```bash
# 1. Confirm Node 24
node --version    # must be v24.x

# 2. Log in to npm as a member of the @ethosagent org
npm login
npm whoami        # should print a member of @ethosagent
npm org ls @ethosagent
```

If `npm whoami` doesn't show an `@ethosagent` member, ask an existing maintainer:
`npm org set @ethosagent <username> developer`

## End-to-end release flow

### 1. Pre-release decision — patch, minor, or major?

| Change type | Bump |
|---|---|
| Bug fixes, docs, internal refactors | patch (`0.2.5 → 0.2.6`) |
| New features, additive API changes | minor (`0.2.5 → 0.3.0`) |
| Breaking changes to public API | major (`0.2.5 → 1.0.0`) |

If anything in `packages/plugin-contract/` changed, see the [Plugin contract bump checklist](#plugin-contract-bump-checklist) before proceeding.

### 2. Bump the version

```bash
make version-bump-patch    # 0.2.5 → 0.2.6
# or
make version-bump-minor    # 0.2.5 → 0.3.0
# or
make version-bump-major    # 0.2.5 → 1.0.0
```

This writes the new version to `VERSION` and syncs every `package.json` in `apps/`, `packages/`, and `extensions/` automatically. All 40+ packages move to the same version — when a customer pastes `node_modules/@ethosagent/core/package.json` in a bug report, that version will match `ethos --version`.

Verify the diff:

```bash
git diff --stat
# should show VERSION + every package.json
```

### 3. Update CHANGELOG.md

Move the `[Unreleased]` section heading to `[<new-version>] — YYYY-MM-DD` and ensure all user-visible changes are listed. Commit together with the version bump:

```bash
git add .
git commit -m "release: v$(make version)"
```

### 4. Run the release

```bash
make release
```

`make release` does, in order:

1. **`make verify`** — runs all pre-flight gates G1–G7 (see [Verification gates](#verification-gates) below). Exits immediately if any gate fails. Nothing ships on a failure.
2. **`git tag v$(VERSION)`** — creates the tag.
3. **`git push origin main v$(VERSION)`** — pushes the commit and tag. This triggers the CI `release.yml` workflow.

### 5. What CI does

`.github/workflows/release.yml` fires on the tag push and runs three stages in sequence:

| Stage | What runs | Fails if |
|---|---|---|
| **Pre-flight** | `node scripts/verify-version.js` (G1–G5, G8) + `pnpm check` (G7) | Any gate fails |
| **Publish** | `make build-publishable` + `make release-npm` | Build fails or npm rejects |
| **Smoke** | `make smoke-npm` — installs published package, checks `--version`, real LLM round-trip | Wrong version or LLM failure |

If any stage fails, subsequent stages do not run. The tag exists but the package may not have published — see [Recovery runbook](#recovery-runbook).

### 6. Post-publish verification

npm propagation takes ~15–30 seconds. Then verify:

```bash
make smoke
```

`make smoke-npm` does:
1. Installs `@ethosagent/cli@<VERSION>` in a fresh temp directory.
2. Runs `ethos --version` — asserts the reported version matches `VERSION`.
3. If `ANTHROPIC_API_KEY` is set, runs a real LLM round-trip (`ethos chat -q "reply with exactly: ok"`) and asserts the response contains "ok".

Or verify manually:

```bash
# Version on npm
npm view @ethosagent/cli version

# All five packages
for pkg in cli types core plugin-sdk plugin-contract; do
  npm view "@ethosagent/$pkg" version
done
```

### 7. Failure paths

See the [Recovery runbook](#recovery-runbook) for step-by-step recovery. The most common: if `make release-npm` fails mid-run, simply re-run it — it's idempotent and skips packages already published at the correct version.

---

## Verification gates

`make verify` runs these gates before tagging. CI runs them again on the tag push — defense in depth.

| Gate | What it checks | What it catches |
|---|---|---|
| **G1** version sync | Every `package.json` version == `cat VERSION` | A package.json wasn't synced; direct edits |
| **G2** no 0.0.0 | No package version is `0.0.0` | New package added without wiring sync |
| **G3** clean tree | `git status --porcelain` is empty | Releasing with uncommitted local edits |
| **G4** on main | HEAD == origin/main | Tagging from a feature branch by accident |
| **G5** no tag yet | `v$(VERSION)` doesn't exist locally or on remote | Re-releasing a version that already shipped |
| **G7** tests green | `pnpm check` (typecheck + lint + test) | The obvious one |
| **G8** NPM_TOKEN | `NPM_TOKEN` env var is set (CI only; skipped locally) | Missing/expired secret discovered mid-publish |

Gates G1 and G2 also run on every pull request in CI (`ci.yml`), blocking merge on version drift.

---

## Recovery runbook

| Failure | Symptoms | Recovery |
|---|---|---|
| Pre-flight gate failed locally | `make verify` exits 1 with a message naming the gate | Fix the issue; re-run. Nothing was published. |
| Pre-flight failed in CI after tag pushed | Workflow red; tag exists but nothing published | Delete tag: `git tag -d v<VERSION> && git push origin :refs/tags/v<VERSION>`. Fix, re-tag. |
| npm publish failed midway | `npm view @ethosagent/cli@<VERSION>` returns 404 | Re-run `make release-npm` — idempotent, skips already-published packages. |
| Published version is broken | Customers report a broken install | (a) `make version-bump-patch` → `make release` for a fix release. (b) Within 72h: `npm deprecate @ethosagent/cli@<VERSION> "broken; use <next>"`. |

---

## Granular targets (manual control)

When you want to inspect each step before proceeding:

```bash
# 1. Bump version (VERSION + all 40+ package.json files)
make version-bump-patch

# 2. Review and commit
git diff --stat
git add .
git commit -m "release: v$(make version)"

# 3. Verify pre-flight gates
make verify

# 4. Tag and push (triggers CI publish + smoke)
git tag "v$(make version)"
git push origin main "v$(make version)"

# 5. Watch CI — then smoke test locally
make smoke
```

Preview what would publish without side effects:

```bash
make release-dry
```

Recovery publish (idempotent):

```bash
make release-npm
```

---

## Quick reference

```bash
# routine patch (most common)
make version-bump-patch
git commit -am "release: v$(make version)"
make release

# minor or major
make version-bump-minor
make version-bump-major

# pre-flight only (no tag/push)
make verify

# preview
make release-dry

# post-publish smoke test
make smoke

# recovery: re-publish what's missing
make release-npm
```

---

## Plugin contract bump checklist

Before `make release`, if **anything in `packages/plugin-contract/` changed**, walk this list:

1. Did the change rename, remove, or add a required field?
   - **No** (additive only) → no major bump needed. Skip the rest.
   - **Yes** → continue.
2. Bump `PLUGIN_CONTRACT_MAJOR` in `packages/plugin-contract/src/version.ts`.
3. Add an entry to `packages/plugin-contract/MIGRATIONS.md` describing what changed and the patch shape plugin authors need.
4. Add a migration note to `CHANGELOG.md` under `[Unreleased] / Changed`, linking to `MIGRATIONS.md`.
5. Confirm the plugin-loader test for the rejection path still fails on a plugin declaring the previous major.

If unsure whether a change is breaking, default to a major bump.
