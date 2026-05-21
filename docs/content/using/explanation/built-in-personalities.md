---
title: "What are the built-in personalities, and why these five?"
description: "Five personalities ship by default — researcher, engineer, reviewer, coach, operator — each with its own toolset, memory scope, and model."
kind: explanation
audience: user
slug: built-in-personalities
updated: 2026-05-12
---

## Context

Ethos ships five [built-in personalities](../../getting-started/glossary.md#built-in-personality) by default: `researcher`, `engineer`, `reviewer`, `coach`, `operator`. They cover the everyday roles an interactive agent plays: gathering information, writing code, critiquing work, thinking through a decision, and running systems. Each one is a directory under `extensions/personalities/data/<id>/` with the same three files described in [Why is personality the unit?](what-is-a-personality.md).

You did not have to pick five. A super-agent that does everything was the easier ship. The reason there are five distinct roles — instead of one role with a `mode` flag — is the same reason a [personality](../../getting-started/glossary.md#personality) is a structural component: an agent good at everything is good at nothing.

## Discussion

### The five roles at a glance

| Personality | What it is for | Toolset shape | Model | Memory scope |
|---|---|---|---|---|
| `researcher` | Gathers and summarises with citations | Web + read + memory + session_search | `claude-opus-4-7` | `global` |
| `engineer` | Writes, edits, runs, tests code | Terminal + read/write/patch + execute + lint + todos | `claude-sonnet-4-6` | `global` |
| `reviewer` | Critiques code and designs | Read + search_files + session_search (no write) | `claude-sonnet-4-6` | `per-personality` |
| `coach` | Helps you think through decisions | Web + memory + session_search (no execution) | `claude-opus-4-7` | `global` |
| `operator` | Runs systems cautiously | Terminal + read/write/patch + execute + tests (no web) | `claude-sonnet-4-6` | `per-personality` |

Tool counts are illustrative; the actual lists are in each personality's `toolset.yaml` under `extensions/personalities/data/<id>/`. Model assignments are defaults — override per-personality via `~/.ethos/config.yaml`.

Switch with `/personality <id>` in chat. The change takes effect on the next turn; the conversation thread does not fork.

### The shape behind the five

Notice the pattern across the table. Every personality answers four questions identically: what is it for, what can it touch, where does its memory live, which model handles its turns. The five entries differ in their answers; the framework treats them uniformly. That symmetry is the load-bearing claim — every role is a structural component, not a special case.

The split between `global` and `per-personality` scope is not arbitrary. The three roles that compose into shared work (`researcher` → `engineer` → `coach` reflecting on what got built) share `MEMORY.md`. The two roles whose job is to keep their own counsel (`reviewer` critiquing without contamination, `operator` running systems without engineer-mode noise) are isolated. The scope reads off the role, not vice versa.

### researcher

A methodical research agent that prioritises primary sources, flags uncertainty, and shows its reasoning. It does not write code. It does not run commands. It reads pages, summarises documents, and tells you what it does not know.

The toolset is web-shaped: `web_search`, `web_extract`, `web_crawl`, plus `read_file`, `search_files`, the memory pair, and `session_search`. No terminal. No write tools. The agent literally cannot execute code or edit a file — that is a different role.

`memoryScope: global` is deliberate. Research findings exist to be consumed by the engineer's writing turn or the operator's deploy turn. Isolating the researcher's notes would defeat its job.

Opus by default because depth matters more than throughput here. Long reads, careful summarisation, and source provenance benefit from a stronger reasoning model.

### engineer

A terse, code-first agent that writes working code immediately and explains only what isn't obvious. It runs commands to verify rather than theorise. It does not pad responses.

The toolset is the widest of the five: `terminal`, the file-write trio (`read_file`, `write_file`, `patch_file`), `search_files`, web reads, code execution, tests, lint, and the todo list. This is the role you reach for when the next step is to *change something*.

`context_layering.mode: progressive` is set in `config.yaml` — sub-AGENTS.md files are discovered as the agent navigates the workspace, so deeper conventions surface as work moves into them. `skill_evolution.enabled: true` flags the engineer's turns for the skill evolver to analyse, so repeated patterns can be promoted into reusable skills.

Sonnet by default because engineer turns iterate. Fast feedback dominates depth here — when you want depth, switch to researcher first, then come back.

### reviewer

A critical, evidence-based reviewer that raises concerns directly and always explains why something is wrong. The toolset is the tightest of the five: `read_file`, `search_files`, `session_search`. No writing. No execution. No web.

The restriction is the point. A reviewer that can edit the thing under review is not a reviewer — it is an engineer with one more excuse. The toolset boundary makes "reviewer cannot modify files" a property of the registry, not a request in the prompt.

`memoryScope: per-personality`. The reviewer's running notes about what is wrong with the codebase do not bleed into the engineer's memory. A reviewer absorbs the opinions it reviews if you let it; this scope says you do not.

Sonnet by default because review is a per-fragment activity — a function, a diff, a design doc — and speed compounds across many small judgements.

### coach

A warm but direct coaching agent that helps users think through decisions by asking focused questions. It connects present challenges to longer-term goals and encourages reflection rather than producing action lists on demand.

The toolset is `web_search`, `web_extract`, the memory pair, and `session_search`. No terminal. No writing. No code execution. A coach that ships code is not coaching — it is engineering disguised as a conversation.

`memoryScope: global` so the coach can read what you said yesterday and what the researcher found this morning. Continuity across sessions is the entire job.

Opus by default for the same reason as researcher: the work is slow, the turns are long, and the cost of a shallow take is high.

### operator

A cautious systems operator that always confirms before irreversible actions and documents everything it does. It runs the same write-tool family as the engineer — `terminal`, `read_file`, `write_file`, `patch_file`, `search_files`, `execute_code`, `run_tests` — but with no web reach and a default-deny posture on destructive operations.

No `web_search` is the load-bearing difference. An operator does not need to browse the web to deploy. Removing the surface eliminates a class of prompt-injection vectors where an attacker-controlled web page tells the agent to run a destructive shell command.

`memoryScope: per-personality`. Operational context — what was deployed, when, with which config — is isolated from the engineer's running notes. An operator that absorbs the engineer's memory carries forward stale assumptions about state.

Sonnet by default. Deploys want predictability. The agent should be terse, deterministic, and willing to ask before doing irreversible things.

### Switching the active personality

`/personality engineer` in chat sets the next turn's personality to `engineer`. The change is immediate; no restart, no session fork. The same conversation continues under the new role.

`/personality` without arguments shows the active personality. `/personality list` enumerates available ones — built-ins plus anything under `~/.ethos/personalities/`. From the shell, `ethos personality set engineer` is the equivalent of the slash command for non-interactive contexts.

A point that catches people: the conversation thread does *not* fork on a personality switch. The reviewer sees the engineer's previous messages in the same thread. This is intentional — you are one human swapping hats, not two different users with two different chats. If you want a clean slate before switching, use `/new`.

### What's shared across all five

Every personality reads from the same `~/.ethos/USER.md` regardless of `memoryScope`. That file describes the person, not the agent, and stays shared on purpose. Switching from coach to operator does not change who you are; only what role is currently helping you.

LLM credentials are also person-scoped, not personality-scoped. Personalities pick a model; the keys to call models live in `~/.ethos/config.yaml`. A reviewer that uses Sonnet and a coach that uses Opus call out from the same machine using the same Anthropic key.

The default personality on a fresh install is `researcher`. The reasoning: the first interaction with a new agent is usually a question, not a code change. Starting in the role that prioritises citations and uncertainty produces a saner first impression than dropping the user straight into engineer mode.

### Extending the set

The built-ins are not a closed system. They live at `extensions/personalities/data/<id>/` inside the package; your own personalities live at `~/.ethos/personalities/<id>/`. Both directories are scanned at startup. A user-defined personality with the same id as a built-in shadows it for that user only — the built-in still ships unchanged in the package.

The cheapest path to a new role is `ethos personality duplicate engineer engineer-typescript`. The duplicator copies the source directory, renames the duplicate, and bumps the `name` field. From there you edit `SOUL.md` to encode the more specific voice ("I write idiomatic TypeScript, never JavaScript") and trim or expand `toolset.yaml` to fit. The resulting personality is yours; it lives under `~/.ethos/personalities/`; it can be committed to a team repo.

### Why these five, not three or seven

Three roles is not enough — the gap between "research" and "code" is wide, and "reviewer" and "operator" each name a category of work that warrants its own toolset and memory scope. Seven roles is too many — every additional role accrues maintenance and trains users to ask "which one of these does my task belong to?" rather than acting.

Five covers the natural axes of an interactive agent: *gather*, *make*, *critique*, *reflect*, *operate*. Adding a sixth means finding a category that is neither a specialisation of an existing role nor a [skill](../../getting-started/glossary.md#skill) that should live inside one of them. The bar is high; the schema is frozen.

### What the built-ins assume about your shell

The built-in personalities expect a reasonable POSIX shell environment. The `engineer` and `operator` personalities call `terminal`; that tool runs commands in the user's shell. The `researcher` personality calls `web_search` and `web_extract`; those tools need network access and, optionally, configured search-engine credentials.

When a personality's listed tool is unavailable (no provider configured, no credentials present), the tool advertises itself as unavailable via `isAvailable?()` and is dropped from the LLM's visible toolset for that turn. The personality stays the same; its surface contracts to what the environment actually supports. A `researcher` on a machine with no `web_search` credentials is still a researcher — it just falls back to whatever search-shaped tools it does have.

### The capability tags

Each built-in declares its `capabilities` in `config.yaml`. A coordinator personality (planned for multi-agent meshes) uses these tags to route work — "this needs research" maps to `capabilities: [research, web]`; "this needs operational caution" maps to `capabilities: [terminal, deploy]`.

The current default set:

- `researcher`: `research`, `web`
- `engineer`: `code`, `file`, `terminal`
- `reviewer`: `review`, `code`
- `coach`: `coach`, `planning`
- `operator`: `terminal`, `deploy`

These are advertised, not enforced. The capabilities field tells a [mesh](../../getting-started/glossary.md#mesh) supervisor "here is what I claim to handle"; the supervisor decides whether to route work here. A future role you author should declare tags that read like the work it does, not like the tools it uses — the goal is for a supervisor to ask "who handles review" rather than "who has read_file".

### The hierarchy of safety in the operator

`operator` is the personality where Ethos's safety machinery shows most clearly. The toolset has the same write-shaped tools as the engineer — `terminal`, `write_file`, `patch_file`, `execute_code` — but the layered defaults around it are different.

The personality's `safety.approvalMode` defaults to `manual` so destructive steps wait for human sign-off — see [Set up approval gates](../how-to/set-up-approval-gates.md) for the three modes and how each surface renders the prompt.

There is no `web_search`, `web_extract`, or `web_crawl` in the operator toolset. The reasoning is structural: a class of prompt-injection vector reads through web content. Removing that surface narrows the attack surface to inputs the user typed in. It does not remove the entire prompt-injection class — a teammate's commit message could still carry an injected payload — but it removes the easiest one.

The combination of "manual approval" + "no web reach" + "default-deny on plugins and MCP" makes the operator the personality you can run on a production-adjacent machine without the same caution you would apply to engineer or researcher.

## Trade-offs

**You give up "one agent for everything."** If your workflow needs one chat that researches and writes and reviews, the answer is `/personality` between turns, not a single super-agent. The thread stays continuous; the role updates. This feels like ceremony once and like clarity ever after.

**You commit to a specific opinion about roles.** The five built-ins encode an opinion: research is separate from writing, review is separate from making, coaching does not run code, operating does not browse the web. If your shop genuinely needs a personality that researches *and* deploys, that combination is one `cp -r` and a `toolset.yaml` edit away — but the default refuses it, and that refusal is the point.

**You pay for five small toolsets instead of one big one.** Each personality has its own `toolset.yaml`. Adding a new tool to one role does not propagate to the others. The trade is explicit per-role surface area, which makes the boundary auditable; the cost is repetition when a tool genuinely belongs everywhere.

Alternatives considered:

- One personality with a `mode` field. Rejected for the reasons in [Why is personality the unit?](what-is-a-personality.md) — the four dimensions must move atomically, and a mode field is a god object.
- A market of community personalities by default. Rejected: a default set with strong opinions is more useful than a buffet. Custom personalities are one directory away; the framework should ship a clear baseline rather than a configuration menu.
- A "supervisor" built-in that picks the right role per turn. Postponed: routing across personalities is a [mesh](../../getting-started/glossary.md#mesh) concern and lives on the building side of the docs, not the using side.

## See also

- [Why is personality the unit?](what-is-a-personality.md) — why these five each get their own directory
- [Why MEMORY.md and USER.md?](memory-model.md) — what global vs per-personality memory means in practice
- [Personality config reference](../reference/personality-yaml.md) — every field these built-ins use
- [Create your first personality](../tutorials/first-personality.md) — author your own role from scratch
- [Slash commands reference](../reference/slash-commands.md) — `/personality` and friends
