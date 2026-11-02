---
paths:
  - "extensions/personalities/**"
  - "packages/types/src/personality.ts"
  - "packages/config/src/decisions.ts"
  - "packages/wiring/src/decision-*.ts"
  - "packages/wiring/src/smart-approver.ts"
  - ".personality-field-count"
---

# Personality

Adding a personality
Drop a directory in ~/.ethos/personalities/<id>/:

<id>/
├── SOUL.md        ← first-person identity (who am I, how do I speak)
├── config.yaml     ← name, description, model (a role or a modelRegistry alias)
└── toolset.yaml    ← flat list of allowed tool names
config.yaml is simple key: value (no nested YAML). Parsed by parseConfigYaml() in extensions/personalities/src/index.ts.

FilePersonalityRegistry.loadFromDirectory() is mtime-cached — it re-reads a personality only when one of its six fingerprinted paths (config.yaml / SOUL.md / toolset.yaml / mcp.yaml / tools.yaml / the skills/ directory — the list is owned by `FilePersonalityRegistry.loadOne`) changes on disk; a no-change refresh is ~6 mtime reads per personality dir with no read()/re-parse. Hot-reload is wired at the surfaces that resolve a personality, not inside the loop: the gateway refreshes every loop registry before it dispatches a turn and at the top of the `/personality` handler (via the optional `personalityDirectory` seam on GatewayConfig, assembled in apps/ethos/src/commands/gateway.ts); web-api's PersonalitiesService refreshes before list/get/characterSheet, and the chat/completions services refresh the loop registry before each turn (`refreshPersonalities` from createAgentLoop's return, threaded through createWebApi); the gateway/serve cron registries reload before each firing. A personality dropped into or edited under ~/.ethos/personalities/ is therefore usable on the next turn/command in every process — no restart. The seams are optional: absent (tests, standalone) → no refresh, and `/personality <unknown>` is validated against the just-refreshed registry so an unknown id is refused instead of silently falling back to the default.

Verify what you built with ethos personality show <id> — it prints the generated character sheet (identity, routing, memory scope, toolset, MCP servers, plugins, fs_reach). renderCharacterSheet() in @ethosagent/personalities is the single generator; the Web Personalities tab renders the same artifact via the personalities.characterSheet RPC.

What does NOT belong on PersonalityConfig (Phase 30.8, amended)
The schema is frozen. The line is IDENTITY vs SETTING, not visible vs invisible.

How a personality PRESENTS itself is identity, and is in scope: which voice it speaks in (voice.tts_voice), and how its call is drawn (voice.call_style). A personality is not only its tools and its plugins — it is also how it looks and feels, and a framework whose agents are all interchangeable grey is not showing you a team. These land as SUB-KEYS of the identity blocks that already exist (today: voice), never as new top-level fields, and never as a metadata passthrough.

Still NOT personality concerns — they belong in skills, in display.* / voice.* in ~/.ethos/config.yaml, or in per-channel adapter config:

voice MODES, VAD tuning, endpointing, barge thresholds — tuning, not identity
emotion / mood / sentiment tags
label or response templates
per-channel UI affordances (one personality rendering differently on Slack than on Telegram)
operator and deployment concerns — transport, credentials, provider rosters, endpoints, anything an operator sets once for the machine
untyped metadata passthroughs — a typed contract does not get an escape hatch meaning "anything"
The test: could two deployments of the SAME personality reasonably disagree about it? Then it is a setting and belongs to the operator. Would changing it make this feel like a different agent? Then it is identity.

Decision-layer enablement is identity (decision-provider-personality amendment). Which decision model a personality uses (`decisions.provider`) and whether each decision site runs for it (`decisions.sites.injection|approver|router: off|shadow|on`) belong to the personality: the same agent with and without a calibrated judgement layer on its approvals is a different agent. The decision provider itself — its credentials, endpoint, model pin, per-site budgets and measured thresholds — stays a setting in `decisions.*` in `~/.ethos/config.yaml`: a machine with no key can always veto, and a threshold is a measurement, not a preference. The field is `PersonalityConfig.decisions` (packages/types/src/personality.ts), parsed by `buildDecisionsConfig` (extensions/personalities/src/index.ts). A site runs only when both halves say so (`resolvePersonalityDecisionSite`, packages/config/src/decisions.ts), resolved per call at each site: the router in `createDecisionTierRouter` (packages/wiring/src/decision-router.ts), the injection classifier in `createDecisionInjectionClassifier` (packages/wiring/src/decision-injection-classifier.ts), the approver in `createSmartApprover` (packages/wiring/src/smart-approver.ts). A global `decisions.sites.*` line in `~/.ethos/config.yaml` is never read — since 0.9.0 it is an unknown key (`DECISIONS_LINE_RE` in the same config file no longer matches it), kept verbatim on write like any other unclaimed line.

skin, verbosity and busy-input mode stay removed. This amendment does not re-add them; per-personality display overrides return only as specific, argued keys on an identity block, not as a general licence. Adding a top-level field to PersonalityConfig still requires the personality-schema-change label, two-maintainer approval, and bumping .personality-field-count in the same commit. The mechanical CI gate (packages/types/src/__tests__/personality-field-count.test.ts) fails if the count drifts — a presentation sub-key must not move it. See CONTRIBUTING.md for the full rule, and docs/content/building/explanation/personality-governance.md for why.

