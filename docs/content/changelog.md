---
title: "Changelog"
description: "Ethos version history — material changes and breaking notes per release."
kind: reference
audience: shared
slug: changelog
updated: 2026-05-12
---

Version history for the `@ethosagent/cli` and its workspace packages. The current version lives in the [`VERSION`](https://github.com/MiteshSharma/ethos/blob/main/VERSION) file at the repo root. Entries are newest first.

## Source {#source}

Entries are seeded from the commit log on `main`. For the canonical machine-readable view, run `git log --oneline` in the repo, or browse the [GitHub commit history](https://github.com/MiteshSharma/ethos/commits/main).

## Conventions {#conventions}

- **Date** · ISO-8601 (YYYY-MM-DD).
- **Status** · `alpha` (interfaces may break without notice), `beta` (stable interfaces, evolving features), `stable` (semantic-version contract).
- **Highlights** · Three lines, one per headline feature.
- **Notable changes** · One bullet per material change.
- **Breaking** · One bullet per breaking change, or "None".

| Version | Date | Status |
|---|---|---|
| [0.2.7](#v0-2-7) | 2026-05-11 | beta |
| [0.2.6](#v0-2-6) | 2026-04-28 | beta |
| [0.2.5](#v0-2-5) | 2026-04-10 | beta |

## 0.2.7 {#v0-2-7}

Date · 2026-05-11
Status · beta

- Docs rewrite under [DOCS.md](https://github.com/MiteshSharma/ethos/blob/main/DOCS.md) — two-persona shell ("Using Ethos" / "Building on Ethos"), Diátaxis four-pillar within each.
- Kanban [tool](getting-started/glossary.md#tool) for personalities that need to coordinate multi-step plans without leaning on the prompt.
- Theming and [skin](getting-started/glossary.md#skin) engine — per-personality and per-user skins, single `@ethosagent/design-tokens` source of truth across TUI and Web.

Notable changes

- Authored the 18-page "Using Ethos" tree (~4,100 lines) covering quickstart, tutorials, how-tos, reference, and explanation.
- Added the `todo` tool for the agent's own task-tracking; enforces a single `in_progress` task at a time (`MULTIPLE_IN_PROGRESS` error code).
- Shipped a 10-skill coding [skill](getting-started/glossary.md#skill) bundle plus the Skills docs hub.
- Split the observability library from the Ethos vocabulary so non-Ethos surfaces can reuse the storage and retention machinery.
- Added a security-controls catalogue and addressed the pre-launch [audience boundary](getting-started/glossary.md#audience-boundary) gaps surfaced during the safety chapters.
- Pinned `pnpm` and tightened the safety-scanner's pre-install scan; gated empty `mcp_servers` blocks from passthrough.
- Switched the agent dev workflow to script-first CI with lefthook hooks and PR templates.
- [Telegram](platforms/telegram.md) gateway no longer crashes on a bad bot token — `Bot.start` rejections are caught and logged.
- Skin override propagates correctly from CLI personality setup and from the Web UI.

Breaking

- None at the public CLI surface. The internal `Skin` token shape under `@ethosagent/design-tokens` evolved; consumers should re-pin the workspace version.

## 0.2.6 {#v0-2-6}

Date · 2026-04-28
Status · beta

- In-process safety watcher and `InjectionClassifier` wired into the production [`AgentLoop`](getting-started/glossary.md#agent-loop).
- Universal always-deny filesystem floor with symlink-defeat for [`ScopedStorage`](getting-started/glossary.md#storage).
- SSRF defenses — scheme allowlist, per-personality net policy, redirect revalidation, policy-fingerprinted [session](getting-started/glossary.md#session) reuse.

Notable changes

- Added the `approvalMode` capability gate and an expanded hardline blocklist.
- Default-deny non-`http(s)` URLs in the browser route.
- Split `policyFingerprint` from the session map key so a forged key alone cannot bypass policy.
- Verified `session.policyFingerprint` instead of trusting the map; strict policy-keyed lookup everywhere.
- Documented the `approvalMode` capability gate as no-op-by-design today; the contract is locked.
- Worktree hook plus hard check on the `agent-sandbox` parent directory.

Breaking

- Sessions persisted before 0.2.6 lack a `policyFingerprint` and will be ignored under the new lookup. `/new` to start a fresh session.

## 0.2.5 {#v0-2-5}

Date · 2026-04-10
Status · beta

- Observability — [`@ethosagent/observability-sqlite`](https://github.com/MiteshSharma/ethos/tree/main/extensions/observability-sqlite) ships and is wired into the production `AgentLoop`.
- Wave B retention — `RetentionConfig`, `safety.observability` config, nightly prune cron, support-bundle export.
- Setup wizard — single-step re-entry, paste enabled on every token and key input, disabled-with-label state for unsupported providers.

Notable changes

- `ethos retention` and `ethos data` CLI commands.
- Support-bundle tar export and an `inspect` archive tier.
- Wave A observability foundation: store turn-level token usage, latency, and tool-call durations.
- `storeToolArgs: 'full'` redaction bypass for trusted operators.
- Onboarding wizard parity with the TUI; arrow-key direction fix on the launch-chat prompt.
- `Storage` abstraction completed in the data CLI surface; `--personality` is surfaced in the help output.
- Tail cursor starvation fix in the observability reader.

Breaking

- None.

## Upgrade notes {#upgrade-notes}

When moving between minor versions, follow this sequence:

1. Read the relevant section above for any **Breaking** entry.
2. Upgrade the CLI: `npm install -g @ethosagent/cli@latest`.
3. Verify the new version: `ethos --version`.
4. If the breaking notes call for a session reset, run `/new` in chat or remove `~/.ethos/sessions.db`.
5. If the breaking notes call for a config rewrite, run `ethos setup` — answers default to the existing values.

The patch stream (0.2.x → 0.2.y) does not change config schemas. Minor bumps (0.x → 0.y) may add fields with safe defaults; old configs continue to parse. Major bumps (0.x → 1.x, when they happen) will document migration steps inline above.

To check the current version programmatically:

```bash
cat /path/to/repo/VERSION
# or
ethos --version
```

## See also {#see-also}

- [Troubleshooting](troubleshooting.md) — error catalogue with Cause / Fix / Prevent per entry.
- [CLI reference](using/reference/cli.md) — every subcommand, flag, and exit code.
- [Glossary](getting-started/glossary.md) — every domain term in one place.
