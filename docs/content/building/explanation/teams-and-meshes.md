---
title: "When should you use a mesh of agents, not one?"
description: "A mesh runs multiple personalities together with a supervisor. Use it when work decomposes by role; one agent stays the right answer when it doesn't."
kind: explanation
audience: developer
slug: teams-and-meshes
updated: 2026-11-03
---

## Context

A single agent with a single [personality](../../getting-started/glossary.md#personality) handles most workflows. You send a message; an `engineer` reads files, writes code, and replies. You switch to a `reviewer`; the reviewer reads diffs and critiques. The two are still one process, one [session](../../getting-started/glossary.md#session), one model on each turn.

Some workflows do not fit that shape. "Plan this change, write the code, review the diff, and summarise the result" is four sub-tasks with four different requirements: planning wants long context and breadth; writing wants direct [tool](../../getting-started/glossary.md#tool) access; review wants read-only restraint; summarising wants conciseness. Forcing one personality through all four leaves you with a generalist that is mediocre at each step.

A [mesh](../../getting-started/glossary.md#mesh) is Ethos's answer. Multiple personalities run together — sometimes as separate processes managed by a supervisor, sometimes as in-process delegations — coordinating through a small set of tools. This page is about when that complication is worth it, what the supervisor adds, what the mesh registry tracks, and what a concrete worked example looks like.

## Parts

| Part | Covers |
|---|---|
| This page | Two shapes, the mesh registry, supervisor vs delegation, delegation tools, trade-offs. |
| [Why does a code-review mesh split writing and reviewing in parallel?](./teams-and-meshes/code-review-example.md) | A worked example: code review with parallel writing and reviewing. |
| [Why does a mesh route by capability and restart a bounded number of times?](./teams-and-meshes/routing-and-lifecycle.md) | Capability matching, heartbeat, single-agent cases, restart loop, sessions, observability. |

## Discussion

### Two coordination shapes

Ethos supports two ways to put multiple personalities behind one workflow:

**Delegation tools.** The active personality calls tools from `extensions/tools-delegation/`. Two of them run in-process: `delegate_task` and `mixture_of_agents` each start a child `AgentLoop.run()`, optionally as a different personality, collect its output and return it to the parent. There is no new process, and the parent's turn waits for the child's reply. The three mesh tools, `route_to_agent`, `dispatch_team` and `broadcast_to_agents`, start nothing locally. They send the task as JSON-RPC (`new_session`, then `prompt`) to another `ethos serve` process listed in the mesh registry, and return that peer's answer. The peer runs the turn with its own loop and personality. `route_to_agent(background: true)` instead asks the peer to `spawn` a detached job and tracks it with a local proxy row.

**Supervisor-managed teams.** `extensions/team-supervisor/` runs a `team.yaml` manifest. Each member personality starts as its own process (`ethos serve`) on its own port. The supervisor watches PIDs, restarts crashed members, writes runtime state to `~/.ethos/teams/<name>.runtime.json`, and registers each member in the mesh's `~/.ethos/meshes/<name>/registry.json`. The members reach each other over the registry; the supervisor keeps them alive.

The two are not alternatives — they compose. A supervisor-managed team is the long-running infrastructure; delegation tools are how an active personality reaches the team's members. Start a `demo` team with a researcher, an engineer, and a reviewer. From the CLI, chat with a `coordinator` personality that uses `route_to_agent` to dispatch sub-tasks to whichever team member fits. The coordinator runs in your shell; the members run as separate processes the supervisor manages.

### What the mesh registry tracks

Each running agent that participates in a mesh writes an entry to the registry — see `extensions/agent-mesh/src/index.ts`:

```typescript
export interface MeshEntry {
  agentId: string;
  capabilities: string[];
  model: string;
  pid: number;
  host: string;
  port: number;
  registeredAt: number;
  lastHeartbeatAt: number;
  activeSessions: number;
}
```

`agentId` is typically `<personality-id>` for team members, or a synthetic id for in-process delegations. `capabilities` is the labels the personality declares (a researcher tags itself "research, citations"; an engineer tags "code, refactor"). `lastHeartbeatAt` is a process-liveness signal — entries older than 30 seconds are treated as stale.

The registry is one file per mesh: `~/.ethos/meshes/<name>/registry.json`. Writes are guarded by a `flock`-style lock file with a 5-second TTL so concurrent registrations do not corrupt each other. This is the lightest possible service discovery — a JSON file, a lock, a heartbeat. No external daemon, no Kubernetes, no Consul. The trade is "works on a developer's laptop"; the cost is "every team member's process must be on the same host".

### When the team supervisor is the right shape

Three conditions push you toward `ethos team start <name>` and a supervisor:

- **The members need to survive a single-turn crash.** A long-running team for a continuous workflow benefits from `auto_restart: true` on each member. The supervisor backs off exponentially, retries, and gives up after a configurable threshold.
- **The members run with different process-level resources.** Different ports, different working directories, different env. A supervisor manifest is the right place to declare that — `extensions/team-supervisor/src/schema.ts` is the parser.
- **You want one-command lifecycle.** `ethos team start demo` boots three personalities at once. `ethos team status demo` shows their state. `ethos team stop demo` cleans them up. The supervisor turns a multi-process workflow into a unit you operate.

### When in-process delegation is the right shape

Two patterns where you skip the supervisor:

- **One-off sub-tasks.** A `coordinator` chatting with you wants to dispatch a specific piece of work to a `reviewer`. It calls `delegate_task` with the right personality id; the child loop runs, returns its output, and ends. No process to manage; no lifecycle to track.
- **Parallel multi-perspective queries.** `mixture_of_agents` spawns N child agents with different personalities, fans out the same prompt, collects their replies, and lets the parent compose a synthesis. The pattern is "two heads on the same question"; the children do not need to outlive the turn.

The signal: if the work is bounded by one turn, use a delegation tool. If the work is a continuous stream of turns that needs persistent processes, use a supervisor-managed team.

### The supervisor model in detail

A `team.yaml` manifest declares what runs. The parser at `extensions/team-supervisor/src/schema.ts` validates the shape:

```yaml
name: demo
description: Demo team
domain_capabilities:
  - research
  - code
  - review
dispatch_mode: coordinator
coordinator: coordinator
mesh: demo
members:
  - personality: researcher
    auto_restart: true
  - personality: engineer
    auto_restart: true
  - personality: reviewer
    auto_restart: true
```

`dispatch_mode` is the routing model:

- `coordinator` — one personality acts as the leader. Inbound work hits the coordinator; the coordinator dispatches to other members. Requires the `coordinator` field to name which personality.
- `self-routing` — members register their capabilities; routing tools (`route_to_agent`) pick a member by capability match. No central leader.
- `broadcast` — every member sees every inbound message. Useful for fan-out workloads.

`mesh` defaults to the team's name; setting it to a shared value lets two teams join one mesh (research + code in one mesh; ops in another). `auto_restart` enables the supervisor's exponential-backoff restart loop. The full reference is in `extensions/team-supervisor/`.

The supervisor's mechanical responsibilities are narrow: spawn member processes, watch PIDs, restart crashed ones, write runtime state. It does not route messages, mediate inter-member communication, or enforce dispatch mode at runtime. Those are responsibilities of the delegation tools and the mesh registry.

### The delegation tools

`extensions/tools-delegation/src/index.ts` exposes five tools that the LLM can call to coordinate across personalities:

- `delegate_task` — Spawn a single child agent with a chosen personality and prompt. Returns the child's final text. Bounded by `MAX_SPAWN_DEPTH = 3` to prevent recursive runaway.
- `route_to_agent` — Pick the best registered member of a mesh by capability match, send the prompt to it, return the reply. The routing tool reads the mesh registry, scores entries by capability overlap with the requested labels, and picks the best fit.
- `dispatch_team` — Send a prompt to every member of a named team in parallel; return their replies as a structured map.
- `mixture_of_agents` — Spawn N child agents with different personalities, send the same prompt to each, return all replies. The parent typically synthesises.
- `broadcast_to_agents` — Send a notification to every registered member of a mesh; non-blocking.

Two implementation notes:

- The child agent's depth is tracked in `ToolContext.agentId` as `"depth:N"`. The delegation tools increment N on spawn and refuse when `N >= MAX_SPAWN_DEPTH`. This is how recursive sub-agent calls do not become infinite.
- The child's output counts against the parent's [tool result budget](tool-result-budget.md) per call. `delegate_task` declares `maxResultChars: 20_000` so a verbose child cannot blow the parent's context.

## Trade-offs

**Mesh adds operational complexity.** A single agent is one process, one log, one debug session. A team is N processes, N logs, a supervisor, a mesh registry, restart policies. The trade is justified when the work genuinely decomposes; it is overhead when the work does not.

**Delegation tools spend the parent's budget.** A `mixture_of_agents` call costs the parent context (the child's reply lands in the parent's `tool_result`) and costs latency (the parent waits). Use the tools when the fan-out wins time; avoid them when the parent could have done the work cheaper itself.

**Spawn depth caps recursion.** `MAX_SPAWN_DEPTH = 3` means a delegated child cannot delegate to its own grand-child more than three deep. For most workflows this is generous; for genuinely recursive ones it is a hard cap and you redesign rather than override.

**No cross-host orchestration.** Mesh, supervisor, and registry are local. A team is one machine's processes. The mitigation is the `AgentMesh` interface — a remote-aware backend is the escape hatch — but the framework does not ship one.

**Session isolation is the default.** A delegated child does not see the parent's session history. This is right most of the time; it is friction the rest of the time. The pattern: pass what the child needs in the prompt; do not assume shared context.

Alternatives considered:

- A single "team agent" that internally tracks role state. Rejected: defeats the per-personality toolset enforcement; the role boundary becomes a prompt convention again.
- Synchronous request/response between members via HTTP. Rejected for in-process delegation: a sub-loop is faster and shares observability without an extra protocol.
- Replicated registry over a service-discovery system (Consul, etcd). Rejected for v1: out of scope for "developer laptop" workloads. The file-based registry is replaceable behind the interface.
- Auto-forwarding parent session to delegated children. Rejected: would cause confused sub-agents in the common case where the parent's recent context is unrelated to the sub-task.

## Recommended reading order

If you're here to wire delegation into your own agent, the next three pages in order:

1. [Why does AgentLoop receive every dependency at construction?](injection-at-construction.md) — child loops are constructed the same way as the parent
2. [Why is there an 80k tool result budget?](tool-result-budget.md) — what a delegated child costs against the parent's budget
3. [How do I publish a plugin?](../how-to/publish-a-plugin.md) — package a delegation tool and the personalities it spawns

## See also

- [Why is personality architecture, not a system prompt?](personality-as-architecture.md) — what a member's role binding actually is
- [Why does AgentLoop receive every dependency at construction?](injection-at-construction.md) — how a child loop is constructed
- [Why is there an 80k tool result budget?](tool-result-budget.md) — what a delegated child costs against the parent's turn
- [HookRegistry reference](../reference/hook-registry.md) — `subagent_spawning` / `subagent_ended` hooks fire across the mesh
- [Plugin SDK reference](../reference/plugin-sdk.md) — how delegation tools register and where they live
