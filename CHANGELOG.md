# Changelog

Material changes to `@ethosagent/cli` and its workspace packages. Release-versioned history lives in `docs/content/changelog.md`; this file tracks unreleased schema-governance changes that require a justification per CONTRIBUTING.md.

## Unreleased

### Added

- **`PersonalityConfig.evolution_approval_mode`** (Phase 3a) — governance dial for Expression self-evolution. Not a skill, tool, or memory concern because it governs how the personality's own identity text (the Expression region of SOUL.md) changes. Distinct from `safety.approvalMode`, which gates tool calls, not identity evolution. Bumps `.personality-field-count` from 25 to 26.
