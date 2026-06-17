# Changelog

Material changes to `@ethosagent/cli` and its workspace packages. Release-versioned history lives in `docs/content/changelog.md`; this file tracks unreleased schema-governance changes that require a justification per CONTRIBUTING.md.

## Unreleased

### Added

- **`PersonalityConfig.evolution_approval_mode`** (Phase 3a) — governance dial for Expression self-evolution. Not a skill, tool, or memory concern because it governs how the personality's own identity text (the Expression region of SOUL.md) changes. Distinct from `safety.approvalMode`, which gates tool calls, not identity evolution. Bumps `.personality-field-count` from 25 to 26.
- **`PersonalityConfig.nightly`** (Phase 3 / P5) — gates the nightly governed-learning pass and its Personality Judge for this personality (`nightly.enabled`, `nightly.judge.enabled`, `nightly.judge.minInteractions`, `nightly.expression`). Not a skill, tool, or memory concern because it governs how a personality's own identity evolves overnight — which steps of the self-evolution loop run and on what activation threshold. Every field defaults to today's behavior when absent (pass + judge + expression all run), so existing personalities are unaffected. Bumps `.personality-field-count` from 26 to 27.
