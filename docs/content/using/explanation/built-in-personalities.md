---
title: "What are the built-in personalities, and why these three?"
description: "Three personalities ship by default — researcher, engineer, reviewer — plus two system personalities for building and managing agents."
kind: explanation
audience: user
slug: built-in-personalities
updated: 2026-05-21
---

## Context

Ethos ships three user-facing [built-in personalities](../../getting-started/glossary.md#built-in-personality) by default: `researcher`, `engineer`, `reviewer`. They cover the everyday roles an interactive agent plays: gathering information, writing code, and critiquing work. Two additional system personalities — `personality-architect` and `team-architect` — exist for building and managing other personalities. Each one is a directory under `extensions/personalities/data/<id>/` with the same three files described in [Why is personality the unit?](what-is-a-personality.md).

You did not have to pick three. A super-agent that does everything was the easier ship. The reason there are three distinct user-facing roles — instead of one role with a `mode` flag — is the same reason a [personality](../../getting-started/glossary.md#personality) is a structural component: an agent good at everything is good at nothing.

## Discussion

### The three roles at a glance

| Personality | What it is for | Toolset shape | Model | Memory scope |
|---|---|---|---|---|
| `researcher` | Gathers and summarises with citations | Web + read + memory + session_search | `claude-opus-4-7` | `global` |
| `engineer` | Writes, edits, runs, tests code | Terminal + read/write/patch + execute + lint + todos | `claude-sonnet-4-6` | `global` |
| `reviewer` | Critiques code and designs | Read + search_files + session_search (no write) | `claude-sonnet-4-6` | `per-personality` |

Tool counts are illustrative; the actual lists are in each personality's `toolset.yaml` under `extensions/personalities/data/<id>/`. Model assignments are defaults — override per-personality via `~/.ethos/config.yaml`.

Switch with `/personality <id>` in chat. The change takes effect on the next turn; the conversation thread does not fork.

### The shape behind the three

Notice the pattern across the table. Every personality answers four questions identically: what is it for, what can it touch, where does its memory live, which model handles its turns. The three entries differ in their answers; the framework treats them uniformly. That symmetry is the load-bearing claim — every role is a structural component, not a special case.

The split between `global` and `per-personality` scope is not arbitrary. The two roles that compose into shared work (`researcher` → `engineer`) share `MEMORY.md`. The role whose job is to keep its own counsel (`reviewer` critiquing without contamination) is isolated. The scope reads off the role, not vice versa.

### researcher

A methodical research agent that prioritises primary sources, flags uncertainty, and shows its reasoning. It does not write code. It does not run commands. It reads pages, summarises documents, and tells you what it does not know.

The toolset is web-shaped: `web_search`, `web_extract`, `web_crawl`, plus `read_file`, `search_files`, the memory pair, and `session_search`. No terminal. No write tools. The agent literally cannot execute code or edit a file — that is a different role.

`memoryScope: global` is deliberate. Research findings exist to be consumed by the engineer's writing turn. Isolating the researcher's notes would defeat its job.

Opus by default because depth matters more than throughput here. Long reads, careful summarisation, and source provenance benefit from a stronger reasoning model.

### engineer

A terse, code-first agent that writes working code immediately and explains only what isn't obvious. It runs commands to verify rather than theorise. It does not pad responses.

The toolset is the widest of the three: `terminal`, the file-write trio (`read_file`, `write_file`, `patch_file`), `search_files`, web reads, code execution, tests, lint, and the todo list. This is the role you reach for when the next step is to *change something*.

`context_layering.mode: progressive` is set in `config.yaml` — sub-AGENTS.md files are discovered as the agent navigates the workspace, so deeper conventions surface as work moves into them. `skill_evolution.enabled: true` flags the engineer's turns for the skill evolver to analyse, so repeated patterns can be promoted into reusable skills.

Sonnet by default because engineer turns iterate. Fast feedback dominates depth here — when you want depth, switch to researcher first, then come back.

### reviewer

A critical, evidence-based reviewer that raises concerns directly and always explains why something is wrong. The toolset is the tightest of the three: `read_file`, `search_files`, `session_search`. No writing. No execution. No web.

The restriction is the point. A reviewer that can edit the thing under review is not a reviewer — it is an engineer with one more excuse. The toolset boundary makes "reviewer cannot modify files" a property of the registry, not a request in the prompt.

`memoryScope: per-personality`. The reviewer's running notes about what is wrong with the codebase do not bleed into the engineer's memory. A reviewer absorbs the opinions it reviews if you let it; this scope says you do not.

Sonnet by default because review is a per-fragment activity — a function, a diff, a design doc — and speed compounds across many small judgements.

### System personalities

Two system personalities ship alongside the three user-facing roles: `personality-architect` and `team-architect`. They appear in the web UI under a "System" divider, separate from the everyday personalities. They still show up in `ethos personality list`.

These personalities exist to build and manage other personalities, not for everyday user work. `personality-architect` helps you author new personality directories — drafting `SOUL.md`, tuning `toolset.yaml`, iterating on `config.yaml`. `team-architect` helps you compose personalities into teams and configure team memory, routing, and coordination.

They follow the same structural rules as any built-in — a directory with three files, a declared toolset, a memory scope — but their purpose is meta: they operate on the personality system itself rather than on your day-to-day tasks.

### Switching the active personality

`/personality engineer` in chat sets the next turn's personality to `engineer`. The change is immediate; no restart, no session fork. The same conversation continues under the new role.

`/personality` without arguments shows the active personality. `/personality list` enumerates available ones — built-ins plus anything under `~/.ethos/personalities/`. From the shell, `ethos personality set engineer` is the equivalent of the slash command for non-interactive contexts.

A point that catches people: the conversation thread does *not* fork on a personality switch. The reviewer sees the engineer's previous messages in the same thread. This is intentional — you are one human swapping hats, not two different users with two different chats. If you want a clean slate before switching, use `/new`.

### What's shared across all built-ins

Every personality reads from the same `~/.ethos/USER.md` regardless of `memoryScope`. That file describes the person, not the agent, and stays shared on purpose. Switching from researcher to engineer does not change who you are; only what role is currently helping you.

LLM credentials are also person-scoped, not personality-scoped. Personalities pick a model; the keys to call models live in `~/.ethos/config.yaml`. A reviewer that uses Sonnet and a researcher that uses Opus call out from the same machine using the same Anthropic key.

The default personality on a fresh install is `researcher`. The reasoning: the first interaction with a new agent is usually a question, not a code change. Starting in the role that prioritises citations and uncertainty produces a saner first impression than dropping the user straight into engineer mode.

### Extending the set

The built-ins are not a closed system. They live at `extensions/personalities/data/<id>/` inside the package; your own personalities live at `~/.ethos/personalities/<id>/`. Both directories are scanned at startup. A user-defined personality with the same id as a built-in shadows it for that user only — the built-in still ships unchanged in the package.

The cheapest path to a new role is `ethos personality duplicate engineer engineer-typescript`. The duplicator copies the source directory, renames the duplicate, and bumps the `name` field. From there you edit `SOUL.md` to encode the more specific voice ("I write idiomatic TypeScript, never JavaScript") and trim or expand `toolset.yaml` to fit. The resulting personality is yours; it lives under `~/.ethos/personalities/`; it can be committed to a team repo.

### Why these three

Three covers the natural axes of everyday agent work: *gather* (researcher), *make* (engineer), *critique* (reviewer). Each axis names a category of work that warrants its own toolset and memory scope. Adding a fourth user-facing role means finding a category that is neither a specialisation of an existing role nor a [skill](../../getting-started/glossary.md#skill) that should live inside one of them. The bar is high.

The system personalities (`personality-architect`, `team-architect`) serve a different purpose — they operate on the personality system itself — and do not count against the user-facing set. They are tools for building, not tools for working.

### What the built-ins assume about your shell

The built-in personalities expect a reasonable POSIX shell environment. The `engineer` personality calls `terminal`; that tool runs commands in the user's shell. The `researcher` personality calls `web_search` and `web_extract`; those tools need network access and, optionally, configured search-engine credentials.

When a personality's listed tool is unavailable (no provider configured, no credentials present), the tool advertises itself as unavailable via `isAvailable?()` and is dropped from the LLM's visible toolset for that turn. The personality stays the same; its surface contracts to what the environment actually supports. A `researcher` on a machine with no `web_search` credentials is still a researcher — it just falls back to whatever search-shaped tools it does have.

### The capability tags

Each built-in declares its `capabilities` in `config.yaml`. A coordinator personality (planned for multi-agent meshes) uses these tags to route work — "this needs research" maps to `capabilities: [research, web]`; "this needs code changes" maps to `capabilities: [code, file, terminal]`.

The current default set:

- `researcher`: `research`, `web`
- `engineer`: `code`, `file`, `terminal`
- `reviewer`: `review`, `code`

These are advertised, not enforced. The capabilities field tells a [mesh](../../getting-started/glossary.md#mesh) supervisor "here is what I claim to handle"; the supervisor decides whether to route work here. A future role you author should declare tags that read like the work it does, not like the tools it uses — the goal is for a supervisor to ask "who handles review" rather than "who has read_file".

## Trade-offs

**You give up "one agent for everything."** If your workflow needs one chat that researches and writes and reviews, the answer is `/personality` between turns, not a single super-agent. The thread stays continuous; the role updates. This feels like ceremony once and like clarity ever after.

**You commit to a specific opinion about roles.** The three user-facing built-ins encode an opinion: research is separate from writing, review is separate from making. If your shop genuinely needs a personality that researches *and* writes code, that combination is one `cp -r` and a `toolset.yaml` edit away — but the default refuses it, and that refusal is the point.

**You pay for three small toolsets instead of one big one.** Each personality has its own `toolset.yaml`. Adding a new tool to one role does not propagate to the others. The trade is explicit per-role surface area, which makes the boundary auditable; the cost is repetition when a tool genuinely belongs everywhere.

Alternatives considered:

- One personality with a `mode` field. Rejected for the reasons in [Why is personality the unit?](what-is-a-personality.md) — the four dimensions must move atomically, and a mode field is a god object.
- A market of community personalities by default. Rejected: a default set with strong opinions is more useful than a buffet. Custom personalities are one directory away; the framework should ship a clear baseline rather than a configuration menu.
- A "supervisor" built-in that picks the right role per turn. Postponed: routing across personalities is a [mesh](../../getting-started/glossary.md#mesh) concern and lives on the building side of the docs, not the using side.

## See also

- [Why is personality the unit?](what-is-a-personality.md) — why each personality gets its own directory
- [Why MEMORY.md and USER.md?](memory-model.md) — what global vs per-personality memory means in practice
- [Personality config reference](../reference/personality-yaml.md) — every field these built-ins use
- [Create your first personality](../tutorials/first-personality.md) — author your own role from scratch
- [Slash commands reference](../reference/slash-commands.md) — `/personality` and friends
