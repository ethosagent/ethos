---
title: "Why skills, separate from tools and personalities?"
description: "A skill is a reusable instruction packet discovered across ecosystems and filtered per personality — a layer above tools, below personalities."
kind: explanation
audience: user
slug: what-is-a-skill
updated: 2026-05-12
---

## Context

Three things in Ethos shape what the agent does next:

- A [tool](../../getting-started/glossary.md#tool) is an *action* the agent can take — a typed function with arguments and a result.
- A [personality](../../getting-started/glossary.md#personality) is the *role* under which the agent acts — the prompt, toolset, memory scope, and model.
- A [skill](../../getting-started/glossary.md#skill) is *instructions for the agent*: a piece of human-written guidance the agent loads when relevant and follows.

Skills are the layer that does not change the agent's identity and does not add new actions. They tell an existing agent *how to do a thing well* — a TDD playbook, a code-review checklist, a deploy runbook, a domain-specific rubric. This page explains why that layer exists separately, how skills are discovered across multiple ecosystems, and how Ethos filters the discovered pool per personality.

## Discussion

### Skill vs tool vs personality

The boundary is sharp in code, even when it feels blurry in prose.

A tool ships executable behaviour. `read_file` reads a file; `terminal` runs a shell command. New tool means new TypeScript code implementing `Tool<TArgs>`, a typed argument schema, a `maxResultChars` cap, an `execute` function returning `ToolResult`. Tools register with the [tool registry](../../getting-started/glossary.md#tool-registry) at wiring time.

A personality is the configuration of an agent. Three files in a directory atomically set who the agent is, which tools it can call, which memory it reads, and which model handles its turns. Changing a personality is `/personality engineer` in chat.

A skill is markdown. A `SKILL.md` file with a YAML frontmatter block declares a name, a description, optionally a list of `required_tools`. The body is human-written instructions the agent reads and follows. No code. No new actions. A skill cannot do anything the personality's existing tools cannot already do — it tells the agent how to use them well for a specific kind of task.

The three layers compose. A `reviewer` personality runs a `code-review-checklist` skill that drives the `read_file` tool. Same skill cannot run under a different personality if that personality's toolset does not include `read_file` — which is the next section.

### Why a separate layer

The honest reason is that instructions belong in instruction shape, not in code shape.

If a code-review checklist were a tool, every project that wanted to tweak it would need a TypeScript change and a redeploy. As a markdown file, it sits next to other markdown documents, is editable in any editor, diffs in any review tool, and propagates to every agent that scans the directory.

If a checklist were baked into a personality's `ETHOS.md`, the personality file would grow unbounded. The reviewer's identity ("I am evidence-based, I always explain why") is small and stable. The checklists the reviewer applies to JavaScript, to Terraform, to SQL schemas, to PR descriptions — those are many, change often, and are properly *guidance under* the identity, not part of it.

If a checklist were a chat-time prompt the user pastes each session, it would not propagate across sessions, would not survive `/new`, would not survive switching platforms. Skills do.

Skills are the layer for *standing instructions that outlive the conversation but do not change the agent*.

### Discovery — read what the user already has

A skill is just a directory with a `SKILL.md` in it. Many ecosystems agreed on this shape (the [agentskills.io](https://agentskills.io) standard) and many users already have a library. Ethos's universal scanner reads them in place.

The default sources walked at startup:

| Source label | Path | Trust tier |
|---|---|---|
| `ethos-bundled` | `extensions/skills-coding/data/*/SKILL.md` (ships inside Ethos) | trusted-repo |
| `ethos` | `~/.ethos/skills/*/SKILL.md` | trusted-repo |
| `ethos-project` | `<cwd>/.ethos/skills/*/SKILL.md` (per-repo) | community |
| `claude-code` | `~/.claude/skills/*/SKILL.md` | community |
| `claude-code-project` | `<cwd>/.claude/skills/*/SKILL.md` | community |
| `opencode-project` | `<cwd>/.opencode/skills/*/SKILL.md` | community |

External tool home directories (OpenClaw, Hermes, OpenCode home) are opt-in via `extraSources` — they can contain hundreds of files, not all of which belong to Ethos.

A dialect parser handles each format. Agentskills.io, OpenClaw, and Hermes each have small differences in their frontmatter; the parser pool unifies them into one `Skill` record with a `qualifiedName` of `<source>/<name>`. Duplicates across sources are deduped by qualified name.

Trust tier is set by which option the source arrives through, not by the caller. `extraSources` is always `community` — red *and* yellow safety findings block. `trustedFirstPartySources` is `trusted-repo` — red blocks, yellow auto-acknowledges so legitimate mentions of `bash`, `gh`, `curl` in skill bodies do not trip the scanner. A caller cannot pass a custom directory at the trusted tier; the scanner refuses that escalation.

The scanner caches per-source by mtime. Re-startup is cheap; only changed sources get re-parsed.

### The per-personality filter

A skill is discovered globally. It does not follow that every personality should see it.

The filter runs at prompt build time. Default mode is `capability`: a skill flows to a personality only if its `required_tools` are reachable by that personality's `toolset`. If the skill declares `required_tools: [terminal, run_tests]` and the personality's toolset omits `terminal`, the skill is not loaded for that personality. The researcher does not see deploy skills. The engineer does not see dietary research skills. Same global library, different visibility per role.

Other modes available via `personality.skills.global_ingest.mode`:

- `tags` — accept skills whose tags match the personality's `accept_tags`; reject on `reject_tags`. Capability check still runs.
- `explicit` — opt-in only. A skill flows only if listed in `allow`.
- `none` — global pool is hidden entirely for this personality. Per-personality skills (under `<personality>/skills/`) still load unfiltered.

Explicit `deny` always wins. Explicit `allow` overrides mode but still runs the capability, env, and permission checks.

The filter does several other things — checks env vars the skill declares, checks the personality's `allowed_skill_permissions` for declared `fs_read`/`fs_write`/`network`/`mcp_env_passthrough` — but capability is the load-bearing one. The contract is: a skill is visible only when the personality could plausibly execute it.

### What a skill looks like

A `SKILL.md` is a markdown body with frontmatter:

```markdown
---
name: code-review-checklist
description: Run when reviewing a PR. Checks for missing tests, unhandled errors, dead code, and API surface drift.
required_tools: [read_file, search_files]
tags: [review, code]
---

When reviewing a diff:

- Identify the changed surface area. List every exported symbol that moved.
- For each new code path, name the case that exercises it.
- Flag any caught-but-not-acted-on exception. ...
```

The body is instructions, not procedure for the user — *procedure for the agent under this personality, when this skill activates*. The agent reads the body; the user does not.

The full set of frontmatter fields, dialect differences, and per-personality filter modes are in the [skills reference](../how-to/use-skills.md) and the source under `extensions/skills/src/`.

### Invocation — model-invoked vs user-invoked

A skill activates in two ways. The model invokes it when the user's message matches the skill's `description` and the per-personality filter has admitted it. The user invokes it directly with `/<skill-name>` in chat.

For sensitive skills — anything with side effects (deploy, commit, send-email) — the frontmatter can set `disable-model-invocation: true`. Only the user's explicit `/<skill-name>` activates it; the model cannot pull it in from a description match. The intent is to keep destructive skills behind a literal command rather than a heuristic match on the user's wording.

`allowed-tools` in the frontmatter declares the subset of tools the skill can use without per-call permission. This trims the surface for skills the user trusts to run a specific set of tools quickly.

### What a skill is not

A skill is not a [tool](../../getting-started/glossary.md#tool). It cannot run code. If a checklist says "run the tests", it works because the personality's toolset includes `run_tests` — not because the skill granted it.

A skill is not a [personality](../../getting-started/glossary.md#personality). It does not change identity, model, memory scope, or toolset. A coach using a research skill is still a coach.

A skill is not a [hook](../../getting-started/glossary.md#hook). Hooks fire at fixed boundaries in the turn cycle and run code; skills are markdown the agent reads at prompt build time.

A skill is not a slash command. `/personality` switches personality; `/new` clears the session. Skills are invoked by the agent — directly via `/skill-name` if the user wants, or model-invoked when the description matches the user's request and the filter lets the skill through.

### Safety scanning at load

Every discovered skill passes through a safety scanner before it joins the pool. The scanner looks for red findings (clear prompt-injection or malicious instruction patterns) and yellow findings (suspicious but ambiguous mentions of dangerous tools). Trust tier governs how the framework reacts:

- `trusted-repo` (your own `~/.ethos/skills/`, Ethos-bundled): red findings block; yellow findings are auto-acknowledged. The user's own skills should not be silently rejected because the body mentions `bash`.
- `community` (everything else, including external tool home directories and project-local): red AND yellow findings block. A skill from a third-party catalogue that mentions running `curl` cannot silently load.

The scanner's job is to refuse the catastrophic combination — a community-sourced skill telling the agent to exfiltrate secrets via a shell command — without making the trusted user experience tedious. A rejected skill is dropped from the pool entirely; the personality filter never sees it.

### Per-personality skills directories

A personality directory can contain its own `skills/` subdirectory. Skills under `~/.ethos/personalities/<id>/skills/` are loaded unfiltered for that personality — the per-personality filter does not apply because the user has already declared the binding by placing the file there.

This is the path for role-specific guidance the user does not want polluting the global pool. A `reviewer/skills/our-coding-conventions.md` applies only to the reviewer and does not need to declare `required_tools: [read_file]` to pass the filter. The directory placement is the binding.

## Trade-offs

**Skills depend on the personality's toolset.** A skill that needs `terminal` is invisible to the reviewer. This is by design — the per-personality filter is what makes a shared library safe — but it means "install this skill globally" does not mean "every role sees it". If you want a skill on every role, every role's toolset has to contain the required tools, or the skill needs to declare no `required_tools` (in which case the filter passes it unconditionally).

**Discovery is sticky.** Skills are scanned from many ecosystems, and a misplaced `SKILL.md` in a `~/.claude/skills/` directory will appear in Ethos too. This is the cost of zero-port compatibility. The qualified-name namespacing (`<source>/<name>`) and the trust tier separation are how the framework handles it; the user is still responsible for what they put in their skill directories.

**Markdown is unenforced.** A skill's body says "always cite primary sources" and the model decides whether to follow it. There is no compiler. Skills are a layer of *guidance*, not contract. The contract layer is tools (the agent literally cannot call what is not in the toolset) and personalities (the agent literally cannot run under a tool the personality forbids). Skills sit above contract; they are how a personality with a fixed toolset gets specific.

Alternatives considered:

- Skills as TypeScript modules. Rejected: porting from Claude Code's `~/.claude/skills/` would require a build step. Markdown is the dialect users already write.
- Skills attached to personalities only (no global pool). Rejected: the same `code-review-checklist` is useful to several reviewers; duplicating it across directories is a maintenance trap.
- Filter by role name (e.g. `roles: [reviewer]` in frontmatter). Rejected: brittle. A skill that says "I am for the reviewer" cannot follow when a user clones the reviewer into `reviewer-typescript`. Filtering by *tool reach* tracks the structural truth: what can this personality actually do.

## See also

- [Why is personality the unit?](what-is-a-personality.md) — the role layer that skills live under
- [What are the built-in personalities?](built-in-personalities.md) — five toolsets the filter resolves against
- [Install and use skills](../how-to/use-skills.md) — picking up an existing library
- [Tool interface reference](../../building/reference/tool-interface.md) — what `required_tools` resolves against
- [agentskills.io](https://agentskills.io) — the open format Ethos's parser follows
