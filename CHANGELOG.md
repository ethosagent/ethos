# Changelog

Material changes to `@ethosagent/cli` and its workspace packages. Release-versioned history lives in `docs/content/changelog.md`; this file tracks unreleased schema-governance changes that require a justification per CONTRIBUTING.md.

## Unreleased

### Added

- **`PersonalityConfig.evolution_approval_mode`** (Phase 3a) — governance dial for Expression self-evolution. Not a skill, tool, or memory concern because it governs how the personality's own identity text (the Expression region of SOUL.md) changes. Distinct from `safety.approvalMode`, which gates tool calls, not identity evolution. Bumps `.personality-field-count` from 25 to 26.
- **`PersonalityConfig.nightly`** (Phase 3 / P5) — gates the nightly governed-learning pass and its Personality Judge for this personality (`nightly.enabled`, `nightly.judge.enabled`, `nightly.judge.minInteractions`, `nightly.expression`). Not a skill, tool, or memory concern because it governs how a personality's own identity evolves overnight — which steps of the self-evolution loop run and on what activation threshold. Every field defaults to today's behavior when absent (pass + judge + expression all run), so existing personalities are unaffected. Bumps `.personality-field-count` from 26 to 27.
- **Personality-directory `tools.yaml` sidecar file** (web-search-provider-selection, Phase 1) — a new per-personality artifact holding, per tool, `{ provider, secret }` — the source of truth for a personality's `Personality → tool → secret` binding (`web_search` is the sole consumer in v1). **§VI amendment class: Substantive** (a new personality-directory extension pattern). It is a sibling artifact loaded by `FilePersonalityRegistry`, exactly like `mcp.yaml` — it is **NOT** a field on the frozen `PersonalityConfig` interface, so it does **not** bump `.personality-field-count` and does not touch the personality field-count drift gate. It carries only a secret NAME, never a value (§V S9), so the directory stays shareable and committable. The global `~/.ethos/config.yaml` `toolSettings` map is a demoted FALLBACK layer, not an override.
