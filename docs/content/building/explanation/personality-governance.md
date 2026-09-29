---
title: "Why is a personality a governed contract?"
description: "A personality is a frozen schema plus a character sheet — every field must describe identity, and the artifact you read is generated, not hand-written."
kind: explanation
audience: developer
slug: personality-governance
updated: 2026-09-29
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

The categories that may never become **top-level fields** are named in `ARCHITECTURE.md` §VII and the `packages/types/src/personality.ts` header: emotion and mood tags, response templates, per-channel display affordances, and anything that grants a capability the [toolset](../../getting-started/glossary.md#tool) does not already express. Each is a real product need. None is a personality concern. Speech and audio configuration is on that list too, with one sanctioned exception — the `voice` block — described next.

### How a personality presents itself is identity

The rule above has been amended once, deliberately, and the amendment is worth reading as a correction rather than a loophole.

The repo owner's position:

> Every personality can choose what its personality is. Personality is not just tools or plugins but also how it looks and feels.

That reverses part of the reasoning the personality-alignment phase used. `skin` was removed on the argument that "a personality is an identity, not a colour palette" — which quietly assumed that anything *visual* is decoration and therefore a per-user setting. That assumption is what the amendment rejects. A team of agents that are interchangeable grey is not a team you can tell apart, and a framework whose whole thesis is that personality is architecture cannot treat presentation as chrome. How a personality **presents itself** — how it sounds, how it is drawn while it holds the floor — is part of who it is.

Four keys carry that today, as sub-keys of the `voice` and `display` blocks:

| Key | What it decides |
|---|---|
| `voice.tts_voice` | Which voice this personality speaks in. |
| `voice.call_style` | Which treatment the Call Stage draws for it — `liquid`, `orb`, or `rings`. |
| `display.avatar_url` | The image drawn for it instead of its generated mark. |
| `display.emoji` | The one emoji shown beside its name (operator decision of 2026-09-29). |

None is a top-level field, and that is the amendment's first limit: presentation attaches to an identity block that already exists, so `.personality-field-count` does not move and the freeze gate keeps doing its job. The second limit is the content test, restated as a pair of questions:

- *Would changing it make this feel like a different agent?* Then it is identity, and it is arguable.
- *Could two deployments of the same personality reasonably disagree about it?* Then it is a setting, and it belongs to the operator in `~/.ethos/config.yaml`.

VAD tuning, endpointing, barge thresholds, provider rosters, credentials, reply-prefix templates, and per-channel affordances all fail the second question — a machine that cannot run a local transcriber has a real reason to disagree, and a personality that renders differently on Slack than on Telegram is not expressing identity, it is expressing a channel. They stay out. A reply prefix such as `[{name}] ` is the worked case: it reads the personality's name and emoji, and it is still a per-bot [channel setting](../../using/reference/config-yaml.md#reply-prefix), because two deployments of one personality can reasonably label their replies differently.

Wake routing is the clearest worked example of the second question doing its job. Which spoken phrase reaches which personality looks like identity — it is, after all, the agent's *name* — and it still belongs to the operator. Two households running the same `engineer` would reasonably disagree about whether the kitchen microphone answers to "hey engineer" or "hey work", because the answer depends on the room, the other agents in it, and who else is within earshot. So [wake routes](../../getting-started/glossary.md#wake-route) live in `voice.wake.routes.<id>` in `~/.ethos/config.yaml` and in `WakeRouteConfig` in `packages/config`, not on `PersonalityConfig` — and the personality is not left nameless by that, because the server synthesizes a default route from the name the personality already declares — the bare name, with a greeting in front of it optional. Identity supplies the name; deployment decides what the house answers to.

Decision-layer enablement is the mirror case. Whether a personality's approvals, injection checks and model routing go through a calibrated decision model looks like a machine setting, and half of it is: the provider's credential, endpoint, model pin, budgets and measured thresholds stay in `decisions.*` in `~/.ethos/config.yaml`, where a machine with no key can always veto. The other half passes the first question. The same agent with and without a judgement layer on its approvals is a different agent, so *which* decision model it uses and *at which sites* is `PersonalityConfig.decisions` (`decisions.provider`, `decisions.sites.<site>: off | shadow | on`). Identity chooses among what the operator allowed; the operator keeps the credential and the calibration.

`skin`, `verbosity` and `busyInputMode` stay removed. The amendment does not restore them, and it is not a general licence for per-personality display overrides: each presentation key is argued and added on its own, on an identity block, or it is not added.

**A default, not a form field.** `voice.call_style` is optional, and an undeclared personality is not shapeless — `resolveCallTreatment` in `packages/types/src/personality.ts` derives a treatment from the personality id, deterministically, so every personality has a distinct look before anyone configures anything. Declaring the key overrides the derivation; an operator's `display.call_style` sits between the two. One function holds that order, and the character sheet prints whichever answer applies — the declared treatment, or the derived one, said out loud rather than left blank. Identity you have to opt into is identity most personalities never get.

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

### A personality cannot rewrite its own definition

A contract the agent can edit is not a contract. The registry hot-reloads a personality whenever one of its files changes on disk, so if a turn could `write_file` its own `toolset.yaml`, it could grant itself any tool on its next turn — and the personality would stop being the architecture.

So the files that define a personality are write-protected from every turn — its own, and every other personality's: `SOUL.md`, `config.yaml`, `toolset.yaml`, `mcp.yaml`, `tools.yaml`, `ETHOS.md`, and everything under `skills/`, `commands/` and `.expression-history/` (the snapshots `ethos personality revert` restores into `SOUL.md`). The global `skills/` and `commands/` under the state directory are write-protected the same way, since every personality loads them. The list is `PERSONALITY_DEFINITION_ENTRIES` (and `STATE_DIR_DEFINITION_ENTRIES` for the global two) in `packages/types/src/personality-definition.ts` (re-exported by `packages/core/src/fs-reach.ts`), and `isPersonalityDefinitionPath` in the same file says whether a path is a definition entry under the state directory. `deriveFsReachPaths` returns the calling personality's entries as `writeDeny` on every branch, so a declared `fs_reach.write` that covers the whole data directory cannot reopen them. No config key turns it off. The learning inbox, `learning/`, is further out of reach: a turn can neither read nor write it (`STATE_DIR_DENY_ENTRIES`, `packages/storage-fs/src/sensitive-paths.ts`).

The turn can still *read* the definition files, which is why this is a write-only floor and not part of the always-deny floor. Three enforcers carry it:

| Layer | Enforcer |
|---|---|
| Storage the tools write through | `ScopedStorage.check` in `packages/storage-fs/src/scoped-storage.ts` (`writeDeny`, plus `personalityDefinitionFloor` for every personality's entries) |
| File-tool capability (`ctx.scopedFs`) | `ScopedFsImpl.checkReach` in `packages/core/src/scoped/scoped-fs.ts` (`writeDenyPaths`, plus the definition-write predicate wiring hands it) |
| Docker sandbox | `DockerExecutionBackend.mountsFor` in `extensions/execution-docker/src/index.ts` mounts the personality directory read-only, with `files/` writable |

Limitation: a personality holding `terminal` whose tools run locally rather than in the Docker sandbox runs a shell no Storage mediates, so none of this binds it. It can edit its own definition files directly. Local execution is the operator's setting, not the personality's: `execution.containerized: true` or `ETHOS_EXECUTION_BACKEND=local` (the deployment is itself the boundary), or `execution.allowLocalFallback: true` when Docker is missing (`resolveExecutionPosture`, `packages/wiring/src/resolve-execution-posture.ts`).

`scaffold_personality` writes through its own Storage rather than the turn's, so it refuses separately: it will not scaffold the calling personality's id, an id already in the personality registry (which covers built-ins), or any id that already has a `config.yaml`. It also refuses a toolset that lists a tool the calling personality does not hold, and refuses outright when the caller cannot be resolved or has no explicit toolset, so creating a personality can never mint a tool its creator lacks. Every refusal runs before anything is written (`scaffoldPersonalityTool` in `extensions/tools-personality-design/src/index.ts`, pinned by `src/__tests__/no-overwrite.test.ts` in that package).

Two things stay writable on purpose. `MEMORY.md` and `USER.md` are content the agent maintains, and the memory provider writes them through its own Storage. `files/` is the personality's asset folder.

The legitimate paths for change run through someone other than the agent. A skill is proposed to the learning inbox and promoted only after a human approves it (`skills_pending_approve` refuses and names `ethos learning approve`). `SOUL.md` and config changes are operator edits — the Web Personalities tab or an editor.

A toolset change, and a change to how the personality presents itself, have one governed path the personality can start. A personality that lists `propose_self_amendment` can file a request to add or remove its own tools, or to set its `name`, `description` and `display.emoji` in `config.yaml` (an identity request: `identityUpdates` in `packages/wiring/src/amendments.ts` sets those three lines and nothing else, never `display.avatar_url`). A new personality's birth ritual ends in an identity request, and applying it clears the birth marker under `learning/birth/`, which no turn can read or write. The tool holds a port that can only file (`AmendmentSubmitPort`, `packages/types/src/amendment.ts`); the checks — a person-started CLI or cookie-web turn, no untrusted content in context, not a built-in, the constitution — run in `createAmendmentIntake` (`packages/wiring/src/amendments.ts`). Applying is the owner's, at `ethos personality amendments apply <id>`, which refuses without a TTY, asks for the personality id to be typed back, and passes the hash of the review it printed so the bytes written are the bytes read (`AmendmentService.apply`, same file). The web shows these requests read-only. The CLI also refuses when `ETHOS_TOOL_PROCESS=1`, which the host shell tools set in every process they start. That is a tripwire, not a boundary: `env -u` defeats it, and a local-shell personality can edit `toolset.yaml` without the CLI anyway, which is why its review says so. The no-untrusted-content check reads the session's stored messages, not memory: text that reached `MEMORY.md` or `USER.md` in an earlier session rides the memory snapshot into a fresh one unseen, so the rationale stays a claim to read, never a fact. Walkthrough: [Review a personality's change request](../../using/how-to/review-personality-change-requests.md).

### How a schema change actually happens

When a field genuinely belongs on the personality — it describes identity, it is not expressible as a skill or a tool or a memory section — the change is a frozen-schema bump:

1. The content test: write the CHANGELOG justification for why this is identity, not display, behaviour, or capability.
2. The mechanical gate: add the field to `packages/types/src/personality.ts` and bump `.personality-field-count` in the same commit.
3. The process gate: the `personality-schema-change` label and two-maintainer approval, per `CONTRIBUTING.md`.

The bump procedure is not red tape. It is the schema defending the property that makes the character sheet possible — that a personality is small enough to read in one screen.

## Trade-offs

**You cannot quietly extend the schema.** Every field is a reviewed decision with a paper trail. A team that wants to move fast on personality features will feel the friction. That friction is the schema doing its job — the alternative is the god-object config every other framework's persona schema drifts into.

**The character sheet is read-only.** You cannot edit a personality through its character sheet; it is a derived view. Editing happens in the three source files (or the Web Identity / Toolset / Config tabs). The sheet is the audit surface, not the control surface — that separation keeps the generated artifact trustworthy.

**Display preferences have no general per-personality home.** Removing `skin`, `verbosity`, and `busyInputMode` means a user who wanted one personality to always render in `paper` and another in `mono` still cannot. The presentation amendment did not reopen that door: it added specific keys that describe how a personality presents *itself* (`voice.tts_voice`, `voice.call_style`, `display.avatar_url`, `display.emoji`), each argued on its own, on an identity block that already existed. A skin is a preference about the whole app; a call treatment is a fact about one agent. The cost of drawing the line there is that every further presentation key is an argument rather than a config entry — which is the friction working, not a gap.

**On local execution, `terminal` can still edit the definition.** A personality with the `terminal` tool whose tools run locally runs `sh -c` as the Ethos user, and nothing mediates that shell's writes — `echo x >> toolset.yaml` succeeds. This is a known limitation, not a gap to patch with a command-string filter, which `cd ..; sed -i` would defeat. If it matters, keep exec tools in the Docker sandbox, the default: leave `execution.containerized`, `ETHOS_EXECUTION_BACKEND=local` and `execution.allowLocalFallback` unset and install Docker. There, the same command fails with "Read-only file system".

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
