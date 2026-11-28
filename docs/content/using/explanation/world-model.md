---
title: "What is a world, and why keep facts in a graph, not in memory?"
description: "A world is a typed, time-aware graph of people, teams and things, with per-personality grants, a proposal queue for shared worlds, and known limits."
kind: explanation
audience: user
slug: world-model
updated: 2026-11-28
---

## Context

[Memory](../../getting-started/glossary.md#memory) (the notes a personality keeps about you and your work) answers "how does this person like to work?". It is prose, so it cannot answer "who owns billing, and who owned it in March?". A world can.

A world is a graph of the people, teams, systems and things you talk about, and the links between them. Every fact carries a date, a source and an author, so you can ask what changed and who said so. A [personality](../../getting-started/glossary.md#personality) (a directory that decides the agent's tools, memory and model) reads the worlds you mount for it and proposes changes. Nothing on a shared world changes until you approve it.

The world model is off by default. Set `world.enabled: true` in `config.yaml` (or turn it on in Settings, Memory, World) and list the `world_*` tools in the personality's `toolset.yaml`. The keys are in the [config reference](../reference/config-yaml/operations.md#world).

## Discussion

### Private and shared worlds

Two kinds of world exist.

| Kind | Id | Who sees it | Who changes it |
|---|---|---|---|
| Private | `personality:<id>` | That personality only, and never in a shared room | The agent writes facts you can retire; you can write too |
| Shared | `world:<slug>` | Every personality you grant, subject to the world's audience | The agent can only propose; you approve |

A shared world is `owner_only` or `shareable`. An `owner_only` world is dropped from a [shared room](../../getting-started/glossary.md#audience-boundary) (a group chat, or an incognito session) even when a personality is mounted on it. A `shareable` world mounted beside it stays usable. The private world is always `owner_only` and cannot be made shareable.

### Mounts and grants

Access needs two files to agree. The world lists who may use it in `worlds/<slug>/world.yaml` (`readers`, `proposers`). The personality lists what it uses in `personalities/<id>/worlds.yaml` (a mount, with mode `read` or `propose` and an optional alias). A mount the world does not list is inert, so a personality cannot grant itself a world. Neither file is writable by a chat turn; use the Worlds tab or `ethos world grant` and `ethos world mount`.

Results from two worlds never blur. Every line carries its world tag (`acme:Ravi`, `private:billing-svc`), and the same name in two worlds is two entities. A write with no `world` is refused when two or more worlds are mounted.

### Facts have two clocks, a source and an author

A fact is an attribute (`Ravi.title = "Staff engineer"`) or a link (`Ravi owns Billing`). Each carries:

| Field | Meaning |
|---|---|
| `valid_from`, `valid_to` | World time: when the fact was true. |
| `recorded_at`, `retired_at` | Ethos time: when Ethos learned it and when it stopped believing it. |
| `source_ref` | Where it came from: a URL, a session, a file. |
| `author` | `user`, `import` or `agent`. |
| `confidence` | 0 to 1. The agent proposes anything under 0.7 instead of writing it. |

The two clocks let you ask "who owned billing on 1 March?" and "what did we believe on 1 March?" as different questions. Facts are closed (`valid_to` set) or retired, never deleted. Only an owner purge removes rows, and it needs a reason.

A `user` or `import` fact is never overwritten or closed by the agent. If the agent disagrees, it creates a conflict proposal. Facts that look like secrets or personal data are refused before they are stored or proposed.

### Proposals and the conflicts inbox

On a shared world every agent write becomes a proposal. A proposal is a batch of facts or a schema change waiting for your yes. Accept replays the facts with the agent as author and records you as the decider; reject remembers the payload so it is not proposed again. A pending proposal expires after `world.proposals.ttlDays` (30), and each world holds at most `world.proposals.cap` (500).

Conflicts, where the agent disagrees with one of your facts, sort first in the inbox. Find it in the World page, in the Worlds tab, or with `ethos world proposals <slug>`.

### First build

Ask a personality to build a world and it reads three things only: its own `MEMORY.md` and `USER.md`, its own sessions that were not shared or incognito, and folders you name. It shows a preview before saving. On a shared world, saving creates proposals; on a private world, it writes `agent` facts you can retire.

### Extraction

`world.extraction: propose` sends facts the agent notices in chat to the proposal queue. It is off by default because its precision is unknown, and it only ever proposes, so nothing it finds reaches a world without your approval.

### Where to look

| Surface | What it gives you |
|---|---|
| World page | Tree, graph and entity views, a date slider (as-of), the conflicts inbox, the schema editor, share and export. |
| Worlds tab (Personalities, edit) | Grants and mounts for one personality, with the reason an inert mount is inert. |
| Settings, Memory, World | The six `world.*` switches. |
| Memory page | Notes link to the entities they mention. |
| `ethos world` | `list`, `create`, `show`, `export`, `import`, `proposals`, `accept`, `reject`, `grant`, `revoke`, `mount`, `unmount`, `purge`. Reference: [ethos world](../reference/cli/evolve-and-learn.md#ethos-world). |
| `/world <slug>` in the TUI | The same tree text as `ethos world show --tree`. |
| Weekly digest | A "World changes" section, owner-only worlds included only in a private delivery. |

### Share snapshots

A share link for a world is a frozen, read-only copy as of a date. Attributes the schema marks `sensitive`, and email and location keys, are stripped unless you untick them. Every string passes redaction, and a snapshot above the byte cap is refused, not truncated. There is no viewer role: sharing is by snapshot link only.

### The watchlist and the ripple walk

The `watchlist` template makes a world of stocks, sectors and supply links ("NVX semis, SKYC cloud"). A feed watcher (RSS or HTTP) can add dated facts to it through the proposal queue. When an event touches a stock, the ripple walk follows supply edges to the stocks on your list and shows the path with its sources.

This is read-only research. Nothing places orders. Every ripple message ends with the line: "A graph path is a reason to look, not advice."

## Trade-offs

Separate budgets cost some duplication. Memory and graph context are capped separately (memory in core, the world block by `world.contextMaxChars`, default 2400), so a long memory does not crowd out the graph and the reverse.

The proposal queue costs your attention. That is the point on a shared world, but a busy feed fills the inbox; the cap and TTL bound it, and extraction stays off until you want it.

### Known limits

| Limit | Detail |
|---|---|
| Save consent is behavioural | The agent asks before saving a first build, but the tool cannot see your yes. On a shared world the result is proposals only. |
| Extraction precision is unknown | Why it proposes only and is off by default. |
| Local shell | A personality with a local shell tool can still edit `worlds/` and `worlds.yaml` directly, like every definition file. The services re-validate on load. |
| Definition floor | Turns cannot write `worlds.yaml` and cannot read or write `worlds/`. |
| No cross-world links | `acme:Ravi` and `private:Ravi` stay separate. |
| No viewer role | Share snapshots only. |
| Plugins | A plugin cannot register a world backend in this version. |
| MCP JSONL | Dates and authors survive a round trip only if the other tool keeps the `ethos:` observations. |
| Entity retype | Renaming or merging an entity type leaves the old rows in the store under a type the schema no longer lists, and undo is refused after it. |
| Purge and share links | Purging a world does not revoke its share links. |
| Share views | A snapshot link shows the tree or graph, not a single entity. |
| Lookup cost | Closing or promoting a fact finds it by scanning the world export, which is slow on very large worlds. |
| Feeds and extraction | `world_extract` usage is not emitted yet; extraction is metered as memory capture. |
| Ripple | A path is not causation. An edge with an unknown share counts as 1. |
| CSV | Export does not escape formula cells. Import through an agent tool is not available; use `ethos world import` or the World page. |
| Web editor | The World page has no first-build preview link yet, and its schema editor saves JSON-style YAML. |

## See also

- [Why is the world graph a new contract type?](../../building/explanation/world-graph-governance.md)
- [config.yaml: world keys](../reference/config-yaml/operations.md#world)
- [ethos world reference](../reference/cli/evolve-and-learn.md#ethos-world)
- [What is the memory model?](./memory-model.md)
- [Audience boundary](../../building/explanation/audience-boundary.md)
