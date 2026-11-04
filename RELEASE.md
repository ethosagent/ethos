# Releasing Ethos

> **Primary channel: npm.** The seven `@ethosagent/*` packages publish in lockstep (below). The **Docker image** (`ethosagent/ethos`) publishes automatically after a successful npm release — see [Docker image release](docs/release/ci-docker-recovery.md#docker-image-release). Homebrew and single-binary distribution are not in scope — revisit when there is customer demand.

## Version source of truth

**`VERSION`** (at the repo root) is the single source of truth. The seven published packages' `package.json` version fields, the binary's `ethos --version` output, and the git tag must all match it. Private workspace packages (`extensions/*`, the private `packages/*` and apps) are bundled, never published, and are not version-synced.

```
ethos/
├── VERSION                       ← source of truth: just "1.0.0\n"
├── apps/ethos/package.json       ← version field MUST match VERSION
└── packages/{types,core,plugin-contract,plugin-sdk,
    web-contracts,sdk}/package.json  ← the other six published packages, all match VERSION
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

If anything in `packages/plugin-contract/` changed, see the [Plugin contract bump checklist](docs/release/ci-docker-recovery.md#plugin-contract-bump-checklist) before proceeding.

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

`make version-bump-*` writes the new version to `VERSION` and runs `scripts/sync-version.js`, which syncs exactly the seven published packages' `package.json` files (`apps/ethos` plus `packages/{types,core,plugin-contract,plugin-sdk,web-contracts,sdk}`) to the same number. All published packages move to the same version — when a customer pastes `node_modules/@ethosagent/core/package.json` in a bug report, that version will match `ethos --version`.

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

Before tagging, run `scripts/smoke-keyless-first-run.sh` (needs a running Ollama with the `< 12 GiB` tier model pulled); it prints first launch → first answer, budget ≤ 120 s excluding download. A miss is a release note, not a blocker (plan keyless-first-run §6.3).

### Step 2 — Trigger the release

#### Primary path: CI workflow (button click)

1. GitHub → repo → **Actions** tab.
2. In the left sidebar, click **release**.
3. Top right: **Run workflow** → branch `main` → **Run workflow**.

The workflow takes ~3–5 minutes. See [What the CI workflow does](docs/release/ci-docker-recovery.md#what-the-ci-workflow-does) below.

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

You can also run the smoke test, which asks the npm registry for each of the seven published packages at `VERSION` and fails if any is missing or at another version (it installs nothing and makes no LLM call):

```bash
make smoke
```

---

## Sections

| Section | Page |
|---|---|
| What the CI workflow does, Docker image release, TTFM targets, verification gates, recovery runbook, granular targets, quick reference, plugin contract bump checklist | [docs/release/ci-docker-recovery.md](docs/release/ci-docker-recovery.md) |
