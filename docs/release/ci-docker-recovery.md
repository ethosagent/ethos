# Releasing Ethos: CI workflow, Docker, gates and recovery

[Back to the release guide](../../RELEASE.md)

## What the CI workflow does

[`.github/workflows/release.yml`](../../.github/workflows/release.yml) is **manual-trigger only** (`workflow_dispatch`). It runs in order, against whatever `VERSION` is at the head of `main` when the button is clicked:

| Step | Command | Fails if |
|---|---|---|
| **Pre-flight** | `pnpm check` + `node scripts/verify-version.js` (G1–G5, G8) | Any gate fails |
| **Build** | `make build-publishable` | Build error |
| **Publish** | `make release-npm` (idempotent lockstep) | npm rejects (auth, version conflict, etc.) |
| **Tag** | `git tag vX.Y.Z && git push origin vX.Y.Z` | Tag-push failure (rare) |
| **Release page** | `gh release create vX.Y.Z --generate-notes` | GitHub API failure (rare) |

If any step fails, subsequent steps do not run. Already-published packages stay published (no rollback), but the tag and GH release may be missing — see [Recovery runbook](#recovery-runbook).

Release notes on the GitHub Release page are auto-generated from Conventional Commit PR titles (`feat:`, `fix:`, etc.) since the previous tag. The curated history lives in the repo in two files: [`docs/content/changelog.md`](../content/changelog.md) is the release-versioned changelog (`ethos upgrade` deep-links its `#v<version>` anchors), and the root [`CHANGELOG.md`](../../CHANGELOG.md) tracks schema-governance changes under Unreleased until a release retitles them into a versioned section.

---

## Docker image release

The Docker image (`ethosagent/ethos`) is a deployment artifact of the npm-published CLI, not a separate build. [`.github/workflows/docker-publish.yml`](../../.github/workflows/docker-publish.yml) publishes it automatically:

- It triggers on a **successful `release` run** and reads the version from that commit's `VERSION` file, so the image tag can never drift from npm.
- It waits for `@ethosagent/cli@<version>` to appear on npm (the image installs the CLI from the registry), then builds `linux/amd64,linux/arm64`.
- A **post-publish smoke gate** pulls the just-published image, brings up the single-service profile (`docker/docker-compose.single.yml`), polls `/healthz`, and asserts a real web-UI reply (RPC) plus an `ethos -z` CLI reply. `latest` is promoted only after the gate passes; prereleases are never promoted.

No manual step is required for the routine path. `workflow_dispatch` with an explicit version is the override (also republishes an existing tag).

## Time-to-first-message (TTFM) targets

Each release, confirm the adoption-funnel targets still hold and record the numbers in the GitHub Release notes. One is enforced in CI; the other two are clean-machine dogfood runs (measured locally with `ethos doctor --funnel` — Ethos ships no phone-home telemetry).

- [ ] **Docker path < 5 min** (`.env` → `docker compose up` → first web-UI reply) — **enforced in CI**: the `docker-publish` smoke gate fails the release if this path exceeds a 300s wall-clock budget. Confirm the gate was green.
- [ ] **First CLI reply < 10 min** on a clean machine (install → `ethos setup` → first streamed reply). Run the [quickstart](../content/using/quickstart.md) on a fresh machine or container; read the elapsed time back with `ethos doctor --funnel` and record it.
- [ ] **First channel reply < 30 min** including a validated, replying channel bot (`ethos setup` → validated Telegram token → "Start the Telegram bot now" → the bot replies). Read `channel_first_reply` back with `ethos doctor --funnel` and record it.

If a target regresses, treat it as a release blocker for the affected surface — the first hour is the product.

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
