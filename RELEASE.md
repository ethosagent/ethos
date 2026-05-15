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

Seven packages publish in lockstep (all at the same version):

| Package | Source | Audience |
|---|---|---|
| `@ethosagent/cli` | `apps/ethos/` | end users — the `ethos` binary |
| `@ethosagent/types` | `packages/types/` | plugin authors — interface contracts |
| `@ethosagent/core` | `packages/core/` | plugin authors + advanced embedders |
| `@ethosagent/plugin-sdk` | `packages/plugin-sdk/` | plugin authors |
| `@ethosagent/plugin-contract` | `packages/plugin-contract/` | marketplace + plugin authors |
| `@ethosagent/web-contracts` | `packages/web-contracts/` | Mission Control / SDK consumers — RPC contract types |
| `@ethosagent/sdk` | `packages/sdk/` | external dashboard authors — typed control-plane client |

**Publish order matters.** `pnpm publish` resolves `workspace:*` deps at publish time to whatever the registry currently exposes, so a consumer must publish *after* its workspace deps. The Makefile's `PUBLISHABLE` list encodes the correct order:

```
types → core → plugin-contract → plugin-sdk → web-contracts → sdk → cli
```

`web-contracts` must precede `sdk` (sdk depends on it). All others sit below in the dependency graph and publish first.

Everything else (`extensions/*`, `apps/{tui,vscode-extension,web}`, `packages/agent-bridge`, etc.) is `"private": true` and bundled into the CLI at build time.

## Prerequisites — first time only

A release can happen two ways: through CI (the **primary** path — a button-click in GitHub Actions) or from a laptop (`make release` — the escape hatch). Each path has its own one-time setup.

### For CI releases (primary)

1. **Create an npm Automation token.** Log in to [npmjs.com](https://www.npmjs.com/) as a member of the `@ethosagent` org → Account → Access Tokens → **Generate New Token → Automation** → copy.
2. **Add it as a repo secret.** GitHub → repo Settings → Secrets and variables → Actions → **New repository secret** → name `NPM_TOKEN`, value = the token from step 1.

### For local releases (escape hatch)

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

### Pre-release decision — patch, minor, or major?

| Change type | Bump |
|---|---|
| Bug fixes, docs, internal refactors | patch (`0.2.5 → 0.2.6`) |
| New features, additive API changes | minor (`0.2.5 → 0.3.0`) |
| Breaking changes to public API | major (`0.2.5 → 1.0.0`) |

If anything in `packages/plugin-contract/` changed, see the [Plugin contract bump checklist](#plugin-contract-bump-checklist) before proceeding.

### Step 1 — Bump the version locally and push to `main`

Start on a clean `main`:

```bash
git checkout main
git pull origin main
git status            # should report nothing to commit, working tree clean
```

Bump the version:

```bash
make version-bump-patch    # 0.2.5 → 0.2.6
# or
make version-bump-minor    # 0.2.5 → 0.3.0
# or
make version-bump-major    # 0.2.5 → 1.0.0
```

`make version-bump-*` writes the new version to `VERSION` and syncs every `package.json` in `apps/`, `packages/`, and `extensions/` to the same number. All packages move to the same version — when a customer pastes `node_modules/@ethosagent/core/package.json` in a bug report, that version will match `ethos --version`.

Eyeball the diff:

```bash
git diff --stat
# should show VERSION + every package.json
```

Commit and push:

```bash
git add .
git commit -m "chore: release v$(make version)"
git push origin main
```

Wait for the regular CI on `main` to pass (tests, typecheck, etc.). If anything fails, fix it on `main` before continuing — don't release red.

### Step 2 — Trigger the release

#### Primary path: CI workflow (button click)

1. GitHub → repo → **Actions** tab.
2. In the left sidebar, click **release**.
3. Top right: **Run workflow** → branch `main` → **Run workflow**.

The workflow takes ~3–5 minutes. See [What the CI workflow does](#what-the-ci-workflow-does) below.

#### Escape hatch: `make release` from a laptop

If CI is down or you need to publish from your machine, run the full pipeline locally:

```bash
make release
```

`make release` does the same things the CI workflow does (verify → build → publish → tag → push → smoke). It's idempotent — re-running after a partial failure skips packages already on npm. The one thing it doesn't do that CI does is create the GitHub Release page — that's a manual `gh release create v$(make version) --generate-notes` afterwards.

### Step 3 — Verify

- `npm view @ethosagent/cli version` should print the new version.
- The **Releases** page on GitHub should have the new entry (CI path) or be missing (local path — create it manually with `gh release create`).
- `git fetch --tags && git tag | tail` should show the new tag.

You can also run the smoke test, which installs the published package in a fresh temp directory, checks `ethos --version` against `VERSION`, and (if `ANTHROPIC_API_KEY` is set) does a real LLM round-trip:

```bash
make smoke
```

## What the CI workflow does

[`.github/workflows/release.yml`](.github/workflows/release.yml) is **manual-trigger only** (`workflow_dispatch`). It runs in order, against whatever `VERSION` is at the head of `main` when the button is clicked:

| Step | Command | Fails if |
|---|---|---|
| **Pre-flight** | `pnpm check` + `node scripts/verify-version.js` (G1–G5, G8) | Any gate fails |
| **Build** | `make build-publishable` | Build error |
| **Publish** | `make release-npm` (idempotent lockstep) | npm rejects (auth, version conflict, etc.) |
| **Tag** | `git tag vX.Y.Z && git push origin vX.Y.Z` | Tag-push failure (rare) |
| **Release page** | `gh release create vX.Y.Z --generate-notes` | GitHub API failure (rare) |

If any step fails, subsequent steps do not run. Already-published packages stay published (no rollback), but the tag and GH release may be missing — see [Recovery runbook](#recovery-runbook).

Release notes on the GitHub Release page are auto-generated from Conventional Commit PR titles (`feat:`, `fix:`, etc.) since the previous tag — that's the de-facto changelog. There is no `CHANGELOG.md` in the repo.

---

## Verification gates

`scripts/verify-version.js` runs these gates. The CI workflow runs them on every release; `make verify` runs them locally. CI also runs G1+G2 on every pull request (via `ci.yml`'s `version-sync` job) to block merging a PR that drifted versions.

| Gate | What it checks | What it catches |
|---|---|---|
| **G1** version sync | Every `package.json` version == `cat VERSION` | A package.json wasn't synced; direct edits |
| **G2** no 0.0.0 | No publishable package is at `0.0.0` | New package added without wiring sync |
| **G3** clean tree | `git status --porcelain` is empty | Releasing with uncommitted local edits |
| **G4** on main | HEAD == origin/main | Tagging from a feature branch by accident |
| **G5** no tag yet | `v$(VERSION)` doesn't exist locally or on remote | Re-releasing a version that already shipped |
| **G7** tests green | `pnpm check` (typecheck + lint + test) | The obvious one |
| **G8** NPM_TOKEN | `NPM_TOKEN` env var is set (CI only; skipped locally where `npm login` provides auth) | Missing/expired secret discovered mid-publish |

---

## Recovery runbook

| Failure | Symptoms | Recovery |
|---|---|---|
| Pre-flight gate failed | Workflow red on the verify step; or `make verify` exits 1 with a gate name | Fix the issue (sync VERSION, push the missing bump, etc.); re-trigger or re-run. Nothing was published. |
| npm publish failed midway | Some `npm view @ethosagent/*@<VERSION>` return 404, others return the version | Re-trigger the workflow (or re-run `make release-npm`) — idempotent, skips already-published packages |
| Workflow succeeded but tag wasn't created | Releases page is missing the entry; `git tag` doesn't list it | Manual: `git tag vX.Y.Z && git push origin vX.Y.Z && gh release create vX.Y.Z --generate-notes` |
| Tag exists but nothing published (rare) | `git tag` shows it; `npm view` returns 404 | Delete tag: `git tag -d vX.Y.Z && git push origin :refs/tags/vX.Y.Z`. Fix, re-trigger. |
| Published version is broken | Customers report a broken install | (a) `make version-bump-patch` → release a fix. (b) Within 72h: `npm deprecate @ethosagent/cli@<VERSION> "broken; use <next>"`. |

---

## Granular targets (manual control)

When you want to inspect each step before proceeding:

```bash
# 1. Bump version (VERSION + all package.json files)
make version-bump-patch

# 2. Review and commit
git diff --stat
git add .
git commit -m "chore: release v$(make version)"
git push origin main

# 3. Verify pre-flight gates locally
make verify

# 4. Trigger the release — either path
#    CI:    GitHub → Actions → release → Run workflow
#    Local: make release

# 5. Smoke test
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
# routine patch (most common — via CI)
make version-bump-patch
git commit -am "chore: release v$(make version)"
git push origin main
# then: Actions → release → Run workflow

# routine patch from a laptop (escape hatch)
make version-bump-patch
git commit -am "chore: release v$(make version)"
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

Before releasing, if **anything in `packages/plugin-contract/` changed**, walk this list:

1. Did the change rename, remove, or add a required field?
   - **No** (additive only) → no major bump needed. Skip the rest.
   - **Yes** → continue.
2. Bump `PLUGIN_CONTRACT_MAJOR` in `packages/plugin-contract/src/version.ts`.
3. Add an entry to `packages/plugin-contract/MIGRATIONS.md` describing what changed and the patch shape plugin authors need.
4. Confirm the plugin-loader test for the rejection path still fails on a plugin declaring the previous major.

If unsure whether a change is breaking, default to a major bump.
