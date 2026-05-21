---
title: "Why is a personality a governed contract?"
description: "A personality is a frozen schema plus a character sheet — every field must describe identity, and the artifact you read is generated, not hand-written."
kind: explanation
audience: developer
slug: personality-governance
updated: 2026-05-13
---

## Context

A [personality](../../getting-started/glossary.md#personality) is a contract. `PersonalityConfig` in `packages/types/src/personality.ts` is the typed surface; the directory of three files at `~/.ethos/personalities/<id>/` is the on-disk form. [Personality is architecture](personality-as-architecture.md) explains *why* the four dimensions — prompt, tools, memory scope, model — bind into one structural unit.

This page is about the other half: how that contract stays honest over time, and how you read what a personality actually is. Governance is two mechanisms working together. The **schema-freeze rule** keeps the contract small — every field has to earn its place by describing identity. The **character sheet** makes the contract legible — `ethos personality show <id>` generates one screen of what a personality is, what it has, and what it can reach.

The two are the same idea from opposite ends. A contract you cannot keep small drifts into a god object. A contract you cannot read is not a contract you can audit. Governance is the discipline that the schema stays one and the artifact stays the other.

## Discussion

### Every field must describe identity

The schema-freeze rule has a content test, not just a process gate: a top-level field on `PersonalityConfig` must answer *who the agent is*, not *how a surface displays it* or *how the runtime behaves this session*.

The personality-alignment phase is the worked example. Four fields were removed because they failed that test:

| Removed field | Why it was not identity |
|---|---|
| `skin` | A visual theme. A personality is an identity, not a colour palette — skins are a per-user setting in `~/.ethos/config.yaml`. |
| `busyInputMode` | A REPL input-handling preference. Belongs to `display.*` in `~/.ethos/config.yaml`, not the role. |
| `verbosity` | A chat-surface output preference. Same — `display.verbosity`, set per user, not per personality. |
| `metadata` | An untyped `Record<string, unknown>` passthrough. A typed contract does not get an escape hatch that means "anything." |

None of these described who the agent *is*. They described how a surface rendered it or how a session behaved. Removing them shrank `.personality-field-count` from 26 to 22 — and the schema got truer to what it claims to be.

The categories that may never become fields are named in `ARCHITECTURE.md` §VII and the `packages/types/src/personality.ts` header: voice and TTS, emotion and mood tags, response templates, per-channel display affordances, and anything that grants a capability the [toolset](../../getting-started/glossary.md#tool) does not already express. Each is a real product need. None is a personality concern.

### The freeze gate makes the rule mechanical

Culture sets the content test; CI enforces the count. `.personality-field-count` at the repo root holds an integer. `packages/types/src/__tests__/personality-field-count.test.ts` parses the `PersonalityConfig` interface, counts its top-level fields, and fails the build if the number drifts from the file.

You cannot add or remove a field without touching that file in the same commit — and touching it pulls in the rest of the bump procedure: the `personality-schema-change` label, two-maintainer approval, and a CHANGELOG entry justifying why the change is not a [skill](../../getting-started/glossary.md#skill), a [tool](../../getting-started/glossary.md#tool), or a memory section. The full procedure lives in `CONTRIBUTING.md` under "Frozen schemas" and `ARCHITECTURE.md` §VII.

The friction is the point. A schema that is cheap to extend becomes the place every half-formed feature lands. The gate makes "just one more field" cost a deliberate, reviewed decision.

### The character sheet is the contract made legible

A governed contract you cannot read is not governed — it is just constrained. The character sheet is the read surface.

```
ethos personality show engineer
```

It generates a single Markdown artifact from the personality's `config.yaml` and `SOUL.md`: the identity line (id and role), the role prose (the first paragraph of `SOUL.md`), model and provider routing, [memory scope](../../getting-started/glossary.md#memory-scope), the explicit toolset, and the MCP servers, plugins, and `fs_reach` the personality can touch. Optional fields render as explicit `(none)` or `(engine default)` states — a reader never has to guess whether a blank means "unset" or "missing."

The artifact is generated, never stored. `renderCharacterSheet` in `@ethosagent/personalities` is a pure function over the config and the `SOUL.md` body; it is regenerated on every call. There is no `character-sheet.md` to drift out of sync with the directory it describes. The CLI prints it; the Web Personalities tab renders the same function's output through the `personalities.characterSheet` RPC. One generator, every surface.

This is why the schema-freeze rule and the character sheet are the same governance. The sheet is only a *tight* character sheet because the schema is small. Every field the freeze rule keeps out is a line the sheet does not have to carry. A 22-field schema renders as one screen; a 40-field schema would render as a form.

### Generated, not authored

The character sheet is deliberately not a file you write. `SOUL.md` is authored — first-person, opinionated, the personality's own voice. The character sheet is *derived* — it reads the authored files and the structural config and presents them together.

The split matters for trust. An authored summary of a personality can lie, or simply lag. A generated one cannot: if the toolset changes, the sheet changes on the next call, because it is the toolset. The character sheet supplements `SOUL.md` — it does not replace it. `SOUL.md` is who the agent says it is; the character sheet is what the runtime will actually do.

### How a schema change actually happens

When a field genuinely belongs on the personality — it describes identity, it is not expressible as a skill or a tool or a memory section — the change is a frozen-schema bump:

1. The content test: write the CHANGELOG justification for why this is identity, not display, behaviour, or capability.
2. The mechanical gate: add the field to `packages/types/src/personality.ts` and bump `.personality-field-count` in the same commit.
3. The process gate: the `personality-schema-change` label and two-maintainer approval, per `CONTRIBUTING.md`.

The bump procedure is not red tape. It is the schema defending the property that makes the character sheet possible — that a personality is small enough to read in one screen.

## Trade-offs

**You cannot quietly extend the schema.** Every field is a reviewed decision with a paper trail. A team that wants to move fast on personality features will feel the friction. That friction is the schema doing its job — the alternative is the god-object config every other framework's persona schema drifts into.

**The character sheet is read-only.** You cannot edit a personality through its character sheet; it is a derived view. Editing happens in the three source files (or the Web Identity / Toolset / Config tabs). The sheet is the audit surface, not the control surface — that separation keeps the generated artifact trustworthy.

**Display preferences lost their per-personality home.** Removing `skin`, `verbosity`, and `busyInputMode` means a user who wanted one personality to always render in `paper` and another in `mono` no longer can. That capability was cut deliberately: per-personality display overrides will return as a per-user preferences layer only if real demand surfaces, designed on evidence rather than carried speculatively on the identity schema.

**The sheet is only as good as `SOUL.md`.** The role prose is the first paragraph of `SOUL.md`. A personality whose `SOUL.md` opens with throat-clearing gets a weak character sheet. The fix is upstream — write a concrete first paragraph — not a richer renderer.

## Recommended reading order

1. [Why is personality architecture, not a system prompt?](personality-as-architecture.md) — the structural thesis this page's governance protects
2. [Personality config reference](../../using/reference/personality-yaml.md) — every field the schema-freeze rule guards
3. [CLI reference](../../using/reference/cli.md) — `ethos personality show` and the rest of the `personality` subcommands

## See also

- [Why is personality architecture, not a system prompt?](personality-as-architecture.md) — why the four dimensions bind into one unit
- [Why is personality the unit, not a system prompt?](../../using/explanation/what-is-a-personality.md) — the user-facing version of the thesis
- [Personality config reference](../../using/reference/personality-yaml.md) — `config.yaml` and `toolset.yaml` fields
- [Build your first personality](../../using/tutorials/first-personality.md) — author the three files from scratch
- [Glossary](../../getting-started/glossary.md) — personality, toolset, memory scope, skill, tool
