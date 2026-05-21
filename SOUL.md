# SOUL.md — what Ethos is, and what it will never become

This document is the product soul of Ethos. [ARCHITECTURE.md](./ARCHITECTURE.md) governs how the code is shaped; [DESIGN.md](./DESIGN.md) governs how surfaces look; the `/docs` skill at [.agents/skills/docs/SKILL.md](./.agents/skills/docs/SKILL.md) governs how we write. SOUL.md governs what we are *building for, and why*. When the three constitutions disagree with a feature idea, this one wins on intent.

It is a compass, not a fence. It should fit on one screen. If a contributor cannot summarise it in a breath, it has failed.

## The one line

**Ethos builds AI agents that have an identity — not a prompt.**

## The thesis

A personality in Ethos is not a system prompt string. It is a structural component — a small directory of files (`SOUL.md` + `toolset.yaml` + `config.yaml`) — that shapes prompt, tool access, memory scope, and model routing **atomically**. Change one, the others move with it. Capability is bounded by identity.

This is the foundational claim of the project. We call it **personality is architecture**, and every other decision in Ethos descends from it.

Keeping the claim honest is the work of **personality governance**: the `PersonalityConfig` schema stays small enough that every field describes *who the agent is*, and `ethos personality show` renders the result as a character sheet a user can read in one screen. See [personality governance](docs/content/building/explanation/personality-governance.md) for how the schema-freeze rule and the character sheet operationalise this thesis.

## Why this matters to the people we build for

The default direction of LLM products is the opposite of ours: one generalist model wearing different prompt-shaped hats. *"You are now an expert researcher"* — but its tools, its memory, its behaviour have not changed. It is one agent pretending to be many. The user cannot audit what it will do, because what it *can* do has not narrowed.

A specialist is a specialist because of what they cannot do, not what they say. A senior engineer does not also do design review and HR. They have a job. The shape of the job is the value.

Ethos agents work the same way. The Engineer cannot research literature. The Researcher cannot edit a file. The Reviewer cannot modify what it critiques. These are not enforced by hope. They are enforced by the toolset, the memory scope, the routing.

You do not get "an AI." You get a team of named, role-bound specialists who know what their job is — and what it isn't.

## The cast

Ethos ships with a small set of built-in personalities. They share DNA:

- **Engineer** — writes working code; tests what ships; refuses to pad.
- **Researcher** — finds primary sources; flags uncertainty; shows the reasoning.
- **Reviewer** — finds real problems; separates blocking from suggestion; does not soften.

Two system personalities — `personality-architect` and `team-architect` — handle building and managing other personalities. They appear in the web UI under a separate System section.

What unites the built-ins is not tone. It is honesty about the role. None of them say *"Great question!"* None of them pretend competence outside their lane. None of them try to be charming when the work calls for being correct.

A user reading any one of these `SOUL.md` files should be able to predict what the personality will do — and what it will refuse to do — before sending a single message. That predictability is the product.

## Teams

Personality is one half of Ethos. Teams are the other half.

A team is not "an orchestrator with sub-agents." It is a set of named personalities, each with its own memory and toolset, that coordinate through a *visible artifact* — a kanban board, a shared topic file, an audit trail. The user can see who has what. The user can see who decided what. Coordination is observable; it is not hidden behind a single chatbot voice.

The promise: **teams you can audit and trust.** Durable across sessions. Coordinated through artifacts, not magic. Transparent by default.

## The decision filter

Before any new feature lands, ask:

1. **Does it preserve specialism?** A single agent doing ten different jobs is the failure mode Ethos is designed against. If a feature widens any one personality's lane in a way that dilutes its role, the answer is no — even when the implementation is easy, and even when a competitor ships it. This is the hard line. The other questions below are taste tests; this one is not.
2. **Does it deepen identity?** Does it make a personality more specific, more accountable, more predictable — or does it dissolve identity into "could be anything"?
3. **Does it make teams more visible, durable, or coordinated?** Or does it make multi-agent work into a black box?
4. **Is the capability auditable?** Can a user see what this feature lets the agent do? Hidden capabilities erode trust; declared ones build it.
5. **Could a user reading the personality's `SOUL.md` predict this behaviour?** If not, the feature is in the wrong place.

If a feature fails (1), it is out — full stop. If it fails several of (2)–(5), it probably belongs in a different product.

## The closing test

If a year from now Ethos has shipped many new features and a new contributor still cannot say, in one breath,

> *"Ethos builds agents that have an identity — not a prompt,"*

then we have lost the plot. Everything in this document exists to keep that sentence true.
