---
title: Skills — skills_list and skill_view
description: "Agent-callable skill introspection. List the skills the personality has access to and read each skill's markdown body."
kind: reference
audience: developer
slug: skills-tools
updated: 2026-09-13
---

# Skills tools — `skills_list`, `skill_view`

Two tools that let an agent discover and read its own [skill](../../getting-started/glossary.md#skill) library at runtime, instead of asking the user through `clarify`. Critical for multi-agent teams sharing a skill set — without these, skills are a static prompt-injection mechanism the agent can't introspect.

## Source {#source}

Tool factory: [`extensions/tools-skills/src/index.ts`](https://github.com/ethosagent/ethos/blob/main/extensions/tools-skills/src/index.ts) (`createSkillsTools`). The factory takes a `listSkills` + `getSkillContent` callback pair; wiring at [`packages/wiring/src/index.ts`](https://github.com/ethosagent/ethos/blob/main/packages/wiring/src/index.ts) supplies those from the universal skill scanner.

## `skills_list` {#skills-list}

| Field | Value |
|---|---|
| Schema | `{}` (no parameters) |
| `toolset` | `'skills'` |
| `maxResultChars` | `10_000` |
| Returns | Bullet list of `- **<name>** [<kind>]: <description>` for every skill the active personality can see |

The scanner applies the personality's [global_ingest](../explanation/audience-boundary.md) policy and the skill's own `required_tools` reachability filter — only skills that *would actually inject* on this personality's next turn appear.

## `skill_view` {#skill-view}

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | string | yes | Skill name (matches the `name:` field in the skill's frontmatter; not the directory id, though they're typically identical) |

| Metadata | Value |
|---|---|
| `toolset` | `'skills'` |
| `maxResultChars` | `30_000` |
| Returns | The skill's full markdown body — `# Title`, `When to use`, workflow, anti-patterns |

Returns `{ ok: false, code: 'not_available' }` for unknown names or for skills the personality can't see. The error mirrors the `skills_list` filter — a personality can't read a skill it can't list.

## Scoping {#scoping}

The skill set returned by `skills_list` is gated by:

1. **Source discovery.** The universal scanner reads from `~/.ethos/skills/`, `~/.claude/skills/`, `~/.cursor/skills/` (community sources), plus first-party bundles like `ethos-bundled/` from `@ethosagent/skills-library`.
2. **Personality `global_ingest`.** The personality config's `skills.global_ingest.mode` (`capability` / `tags` / `explicit` / `none`) plus `allow` / `deny` lists filter the candidate pool.
3. **`required_tools` reachability.** A skill whose `required_tools` aren't all in the personality's `toolset.yaml` is filtered out (logged at INFO at boot).
4. **Team scope (when present).** Skills authored at the team layer surface to all members of that team.

`skills_list` reflects the final intersection, not the raw scan output — what the agent sees is what it would get if it invoked the workflow described in the skill.

## skills.global_ingest.\* {#skills-global-ingest}

Type: dotted block in the personality's `config.yaml` · Default: unset (`capability` mode)

Filters which skills from the global pool this personality sees. Skills in the personality's own `skills/` directory are never filtered. Walkthrough: [Add a skill](../how-to/add-a-skill.md).

Source: `skills` on `PersonalityConfig` in [`packages/types/src/personality.ts`](https://github.com/ethosagent/ethos/blob/main/packages/types/src/personality.ts) (shape `IngestConfig`, `packages/types/src/skill.ts`), parsed by `buildSkillsConfig` in [`extensions/personalities/src/index.ts`](https://github.com/ethosagent/ethos/blob/main/extensions/personalities/src/index.ts), applied by [`extensions/skills/src/ingest-filter.ts`](https://github.com/ethosagent/ethos/blob/main/extensions/skills/src/ingest-filter.ts).

| Field | Type | Default | Description |
|---|---|---|---|
| `skills.global_ingest.mode` | enum | `capability` | `capability` — a skill is visible when its `required_tools` are all in this personality's reach (default). `tags` — accepted when a tag is in `accept_tags`, rejected when a tag is in `reject_tags`; the capability check still runs. `explicit` — only skills named in `allow`; the capability check still runs. `none` — the global pool is hidden. A value outside these four is ignored and `capability` stands. |
| `skills.global_ingest.accept_tags` | comma-separated tags | unset | Tags `tags` mode accepts. |
| `skills.global_ingest.reject_tags` | comma-separated tags | unset | Tags `tags` mode rejects. |
| `skills.global_ingest.allow` | comma-separated `<source>/<name>` | unset | Loaded in every mode, `none` included, once the reach, env and permission checks pass (`filterSkill` checks `allow` before the mode). In `explicit` mode these are the only global skills loaded. |
| `skills.global_ingest.deny` | comma-separated `<source>/<name>` | unset | Checked before the mode; a listed skill is rejected in every mode. |
| `skills.global_ingest.fallback_unknown` | enum | `allow` | What `capability` mode does with a skill that declares no `required_tools`: `allow` (default), `warn`, or `deny`. A value outside these three is ignored. |

```yaml
skills.global_ingest.mode: explicit
skills.global_ingest.allow: claude-code/code-review, ethos/explain-code
skills.global_ingest.deny: claude-code/auto-commit
```

## skills.injection_mode {#skills-injection-mode}

Type: enum in the personality's `config.yaml` · Default: `index`

How global-pool skills enter the system prompt. Parsed by `buildSkillsConfig` in [`extensions/personalities/src/index.ts`](https://github.com/ethosagent/ethos/blob/main/extensions/personalities/src/index.ts), read by `SkillsInjector` in [`extensions/skills/src/skills-injector.ts`](https://github.com/ethosagent/ethos/blob/main/extensions/skills/src/skills-injector.ts) and by `usesSkillIndexMode` in [`packages/core/src/agent-loop/ghost-skills.ts`](https://github.com/ethosagent/ethos/blob/main/packages/core/src/agent-loop/ghost-skills.ts).

| Value | Meaning |
|---|---|
| `index` | A table of skill names and descriptions; the agent loads a body on demand (default). |
| `full` | Every matching skill's full body. Suited to small collections only. |

A value outside these two is ignored and `index` stands.

```yaml
skills.injection_mode: full
```

Notes:

- Write the dotted form. An indented `skills:` block fails the personality load — only `safety:` may nest (`NESTED_BLOCKS`).
- Put comments on their own line. The loader reads everything after `key:` as the value, so a trailing `# comment` becomes part of it.

## Capability rationale {#capabilities}

`capabilities: {}` on both tools — no framework gate. The reason: skills are prose, not capability-acquiring code. Reading a skill body doesn't grant the agent any execution surface; it merely loads guidance into the context the agent already has access to. The gating happens at scan time, not at tool-call time.

To **prevent** a personality from introspecting its skills (rare, but if you want it), omit `skills_list` and `skill_view` from the personality's `toolset.yaml`.

## Examples {#examples}

### Self-discovery {#example-discovery}

The agent encounters an unfamiliar task and inventories what it knows:

```text
1. skills_list()
   → 5 skills available:
     - **plan** [companion]: Render a long-form plan file in the standard Ethos shape...
     - **writing-plans** [companion]: Plan template + section conventions for the `plan` skill...
     - **spike** [companion]: Throwaway experiments to validate an idea before build...
     - **tdd**: TDD — enforce RED-GREEN-REFACTOR, tests before code.
     - **code-review** [companion]: Pre-commit gate. Reviews staged or branch-scoped diff...
```

The agent then picks the skill that matches the task and loads it:

```text
2. skill_view("plan")
   → <full markdown body of plan/SKILL.md>
```

### Cross-agent discovery {#example-cross-agent}

A team has six personalities, each with different toolsets and therefore different visible skills. A coordinator personality with the same `skills` access can audit which skills propagate where:

```text
skills_list()  → list per the coordinator's reach
skill_view("requesting-code-review")  → confirm the body matches expectations
```

If a teammate complains "I don't have the X skill" you can confirm the rejection by reading their `required_tools` versus the personality's toolset — that's the most common cause.

### Anti-pattern: agent invents skill content {#example-antipattern}

Without these tools, an agent asked "do you have a skill for handling PRs?" would either invent a procedure or call `clarify` and bother the user. With `skills_list` + `skill_view`, the answer is local. This is the structural fix.

## Errors {#errors}

| `code` | When |
|---|---|
| `not_available` | `skill_view` for an unknown / unscoped name |
| `input_invalid` | `skill_view` called without `name` |

## See also {#see-also}

- [`use-skills`](../../using/how-to/use-skills.md) — operator how-to for installing and authoring skills.
- [`ethos-skill-authoring`](https://github.com/ethosagent/ethos/blob/main/skills/data/framework/ethos-skill-authoring/SKILL.md) — the bundled skill that documents skill authoring.
- [Add a skill](../how-to/add-a-skill.md) — setting `skills.global_ingest.*` on a personality, with worked examples.
