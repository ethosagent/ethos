---
name: world-graph
description: Keep a graph of the people, teams, systems and things the user talks about and how they relate. Use it to record facts as they come up, answer who owns / who knows / what changed, import or export a graph, and run the first build. Facts about the world go to the graph; how to work with the user goes to memory.
version: 1.0.0
author: ethosagent
tags: [knowledge, graph, world-model, entities, relations]
required_tools: [world_query]

ethos:
  category: knowledge
  default_personalities: []
  prerequisites:
    external_cli: []
    auth: []
    env_vars: []
    optional_tools: []
  integrates_with:
    - tool: world_query
      role: the entry point. Search entities and facts by name, type or text. Always search before you create anything.
    - tool: world_neighbours
      role: walk outward from one entity (shown as `#id`) to see what it links to, up to a few hops.
    - tool: world_history
      role: show every version of the facts about one entity, including closed ones. Use it for "what changed".
    - tool: world_assert
      role: write facts. Applied on the private world, proposed on a shared one. Every fact needs a source and a date.
    - tool: world_close
      role: end a fact by setting `valid_to`. Facts are never deleted.
    - tool: world_propose
      role: send facts to a shared world as a proposal for its owner to review, in one batch.
    - tool: world_schema_change
      role: ask for a new entity type or edge type. Check existing types first.
    - tool: world_import
      role: load facts from a file. Formats are facts-yaml and mcp-jsonl. Refused in a shared turn.
    - tool: world_export
      role: write a world out as text (facts-yaml, json, graphml, mermaid, mcp-jsonl, csv).
    - tool: world_build
      role: the first-build pipeline over the user's sources. It may refuse as not implemented; say so and fall back to asserting facts from chat.
  surface_metadata:
    invocation_trigger: "user describes people, teams, systems, stocks or how things relate; asks who owns / who knows / what changed; asks to build or update a graph"
    estimated_turns: "1-4"
---

# World Graph

The graph holds facts about things and how they relate. Keep it small and true.

## Graph or memory?

Facts about things and how they relate go to the graph ("Ravi owns billing"). How to work with the user goes to memory ("prefers short answers"). Never both.

## Modelling rules

- Entity types are singular nouns: `person`, `team`, `service`.
- Edge types are active-voice verbs: `owns`, `reports_to`, `depends_on`.
- If nothing links to it, it is an attribute. If something does, it is an entity.
- Search with `world_query` before creating. If the entity exists, add an alias instead of a duplicate.
- Never delete. Close the old fact with `valid_to` (`world_close`), then open the new one.
- Every fact needs a source and a date.
- If confidence is under 0.7, ask the user first.

Entities show up as `#id` in results. Use that id to refer to one.

## Procedures

**First build.** Run `world_build` to get an estimate, then run it, then show a preview in the format the tool returns. Ask the user to pick one of the three save choices before anything is saved. The tool does not ask for consent itself, so you must.

**Update from chat.** "Ravi took over billing": find the old owner fact, close it with `world_close`, open the new one with `world_assert`, cite the message as the source, and confirm in one line.

**New link type.** Check the existing types with `world_query` first. On the private world, add it with `world_schema_change`. On a shared world, propose it. Give a one-line reason.

**Conflict with a user fact.** Never overwrite. Propose the change with `world_propose` and mention it once.

**Shared-world proposals.** Batch them into one `world_propose` call so the owner gets one review.

**Feed turn.** A watcher created with `prompt_prefix: "world-feed:<world>"` wakes you with new feed items. Propose dated facts in one `world_propose` call, each with `source_ref` set to the item's own URL. If a message shows a ripple through supply links, end it with: "A graph path is a reason to look, not advice."

**Bulk.** Use `world_import` for a facts file and `world_export` to hand one back.

## Worlds

When more than one world is mounted, pass `world` on every write. Results are tagged with their world. Never merge `acme:Ravi` with `private:Ravi`.

## Never

- Store secrets, health, salary or other sensitive personal data.
- Overrule a fact authored by the user.
