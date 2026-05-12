---
title: "When should you use a mesh of agents, not one?"
description: "A mesh runs multiple personalities together with a supervisor. Use it when work decomposes by role; one agent stays the right answer when it doesn't."
kind: explanation
audience: developer
slug: teams-and-meshes
updated: 2026-05-12
---

## Context

A single agent with a single [personality](../../getting-started/glossary.md#personality) handles most workflows. You send a message; an `engineer` reads files, writes code, and replies. You switch to a `reviewer`; the reviewer reads diffs and critiques. The two are still one process, one [session](../../getting-started/glossary.md#session), one model on each turn.

Some workflows do not fit that shape. "Plan this change, write the code, review the diff, and summarise the result" is four sub-tasks with four different requirements: planning wants long context and breadth; writing wants direct [tool](../../getting-started/glossary.md#tool) access; review wants read-only restraint; summarising wants conciseness. Forcing one personality through all four leaves you with a generalist that is mediocre at each step.

A [mesh](../../getting-started/glossary.md#mesh) is Ethos's answer. Multiple personalities run together — sometimes as separate processes managed by a supervisor, sometimes as in-process delegations — coordinating through a small set of tools. This page is about when that complication is worth it, what the supervisor adds, what the mesh registry tracks, and what a concrete worked example looks like.

## Discussion

### Two coordination shapes

Ethos supports two ways to put multiple personalities behind one workflow:

**In-process delegation.** The active personality calls tools from `extensions/tools-delegation/`: `delegate_task`, `route_to_agent`, `dispatch_team`, `mixture_of_agents`, `broadcast_to_agents`. Each tool spawns a child `AgentLoop.run()` with a different personality, collects its output, and returns the result to the parent. No new process; the parent's turn awaits the child's reply.

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

### A worked example: code review with parallel writing and reviewing

Concrete scenario. You are chatting with a `coordinator` personality. The user asks "add input validation to the parseConfig function and review the diff".

The coordinator's reasoning at the LLM level:

- The work has two phases that can run in parallel-ish — `engineer` writes the validation, `reviewer` reviews the result.
- Dispatching to a team in parallel is one tool call; the coordinator picks `mixture_of_agents` so both members see the same prompt at once.
- After both return, the coordinator synthesises a reply that includes the diff and the review.

In the agent stream that comes out of `AgentLoop.run()`, the model emits something close to:

```typescript
// One tool_use from the coordinator
{
  tool: 'mixture_of_agents',
  args: {
    prompts: [
      { personality: 'engineer', prompt: 'Add input validation to parseConfig in src/config.ts...' },
      { personality: 'reviewer', prompt: 'Review the input validation added to parseConfig...' },
    ],
  },
}
```

What the framework does:

- `executeParallel` runs `mixture_of_agents` once. Inside, `mixture_of_agents` spawns two child `AgentLoop.run()` calls — one with `engineer`, one with `reviewer`.
- The engineer's child loop reads `src/config.ts`, writes the changes, returns a summary text.
- The reviewer's child loop reads the (just-written) file, evaluates the change, returns a review text.
- The two children complete; `mixture_of_agents` returns a structured `ToolResult` with both replies tagged by personality.
- Back in the coordinator's turn, the LLM sees the structured result and composes a final reply that quotes both children.

The user sees one reply that includes the diff and the review. The framework saw two child loops, each scoped to its own personality. The reviewer's `per-personality` [memory scope](../../getting-started/glossary.md#memory-scope) means its read-only critique is not coloured by the engineer's in-flight notes; the engineer's writes never see the reviewer's opinions.

This is the headline property of the mesh model. The four dimensions of each personality — prompt, toolset, memory scope, model — apply *inside the child loop*. The engineer's write tools are unavailable in the reviewer's child even though they live in the same mesh, because the reviewer's `toolset.yaml` does not list them. The boundary is structural, not advisory; see [Why is personality architecture?](personality-as-architecture.md) for the underlying mechanism.

### Capability matching and the routing heuristic

`route_to_agent` picks a mesh member by capability overlap. Each registered `MeshEntry` carries a `capabilities: string[]` list — labels the personality declared in its `config.yaml` (`capabilities: research, citations`) or that the team manifest set per-member.

The routing tool receives a `prompt` and an optional `required_capabilities` list, scores every registered entry by how many of the requested labels overlap with the entry's declarations, breaks ties by `lastHeartbeatAt` (freshest wins), and routes to the best match. A `dispatch_team` call follows the same logic but fans out to every team member rather than picking one.

This is a deliberately crude heuristic. There is no embedding-based capability matching, no learned router, no model-in-the-loop that picks the right member. The trade is the routing decision is *legible* — you can read why a request landed on a specific member and trace it back to capability labels. A smarter router would be one more thing to debug when a wrong member gets the work.

The mitigation when crude matching is not enough: the coordinator personality is itself an LLM. A `dispatch_mode: coordinator` team puts a thinking model in the routing path. The coordinator reads the user's request, looks at what each team member is for, and picks the right member explicitly via `route_to_agent` with the matching capability. Smart routing is the coordinator's reasoning, not the registry's algorithm.

### Member lifecycle and the heartbeat contract

Every member of a team writes a heartbeat to its registry entry every 10 seconds (configurable). The mesh treats an entry as live if `Date.now() - lastHeartbeatAt < 30000`. Stale entries are eligible for cleanup by the next writer that takes the registry lock.

This is the lightest service-discovery contract that works. There is no daemon polling member health, no liveness probe over HTTP, no Consul. The supervisor knows its members are alive because they hold open the heartbeat write loop; the mesh knows the same because it reads the registry. When the supervisor restarts a crashed member, the new process registers afresh with a new PID, and the previous stale entry gets reaped.

A subtle property: the heartbeat is a *writer-driven* signal, not a *reader-driven* check. A consumer of the registry (a `route_to_agent` call, an external `ethos mesh status`) sees what the writers said, with at most 30 seconds of staleness. If you need fresher liveness, the cost is a one-time `process_logs` peek or a direct `ethos team status` invocation; the registry intentionally trades freshness for cost.

### What stays single-agent

A mesh is the right shape when the work *decomposes by role*. A single agent stays the right shape when:

- The task is one conversation in one voice. "Explain this codebase" is a coach question, not a coordinated multi-role workflow.
- The user is iterating on a single artefact and switching personalities by hand. The engineer writes a patch; you switch to the reviewer (`/personality reviewer`) and ask it to critique; you switch back. The atomicity of single-personality switching is the right model; no supervisor needed.
- The performance cost of spawning sub-agents exceeds the value. A child loop is a full turn with its own prompt build, memory prefetch, model call. For short tasks, the spawning overhead is worse than letting one personality handle the whole thing.

The signal: if you find yourself wanting *both* the engineer's tools and the reviewer's restraint in one reply, you want a coordinator with a mesh. If you want one and then the other, you want personality switching.

### One mesh, one host, one user

The mesh registry is a JSON file on disk. The supervisor watches local PIDs. The delegation tools spawn in-process child loops or reach registered members over local ports. None of this scales across machines.

This is intentional for v1. The use case the model targets is "a developer running a multi-agent workflow on their laptop" or "a single workspace hosting one team for one user". A team that spans hosts, a mesh that survives a single-machine reboot, a registry replicated across nodes — those are all unbuilt. The escape hatch is the `AgentMesh` interface (`extensions/agent-mesh/src/index.ts`); a different backend could replace the file-based registry without changing the delegation tools.

The current shape is enough for the workflows that motivated the design: a `coordinator` chatting with you while three specialists run alongside, or an in-process delegation that fans out for one turn. Larger orchestration is somebody else's framework.

### The supervisor's restart loop has bounded retries

`auto_restart: true` is not "restart forever". The supervisor applies an exponential backoff (1s, 2s, 4s, 8s, …) capped at 60s between attempts, and gives up after a configurable failure count within a sliding window (default: 5 failures in 5 minutes). A member that fails this threshold transitions to the `failed` state; the supervisor stops attempting to restart it until the operator intervenes.

The states a member can be in: `running` (alive, heartbeat current), `restarting` (between backoff attempts), `failed` (gave up — operator action required), `stopped` (no supervisor active for this team). `ethos team status <name>` reads these from `~/.ethos/teams/<name>.runtime.json`.

The reasoning for the cap: a crashed-on-startup member that keeps crashing is signalling a configuration error, not a transient failure. Restart-forever would burn CPU and pollute logs without addressing the underlying issue. The operator's next step is `ethos team logs <name> --member <id>` to read why the member is crashing, fix the config, and `ethos team start` again.

### Sessions across the mesh

Each member of a team has its own `SessionStore`. A child loop spawned via `delegate_task` gets a fresh session keyed under the parent's session id plus a synthetic suffix; it does not see the parent's conversation history.

This is the right default — a sub-agent should not be confused by the parent's mid-thought. The mitigation when continuity matters: pass the relevant context into the child's prompt explicitly. The parent decides what the child needs to know; the framework does not auto-forward history.

The exception is `route_to_agent` against a long-running team member. The member's session is preserved across calls (the supervisor keeps the process up; the session store is on disk). A coordinator that routes three times to the same engineer member gets a member with three turns of history. The session key is the member's process key, not the parent's.

### Skin and theming respect the active member

A small but visible property: each personality can declare `skin` in its `config.yaml`. When a team member is the active personality for a turn, its skin is the one the surface applies. The CLI's `SkinContext` and the web's `ConfigProvider` consume the same token set.

For a coordinator-mode team, this means the surface theme follows the coordinator's preference (assuming the user has not pinned a global skin). For self-routing teams where the active member changes turn-to-turn, the theme can shift with the routing decision. Most users do not exercise the property; the ones who run multi-personality teams with distinct visual identities appreciate it.

The user pin wins. If `~/.ethos/config.yaml` declares a global skin, switching members does not override it. The override is opt-out, not opt-in.

### Observability across a mesh

Every member writes to the same observability database (`~/.ethos/observability.db` via `extensions/observability-sqlite/`). The traces are keyed by `sessionId`, with a parent/child relationship for delegated turns. The CLI's observability commands (`ethos obs traces`) walk the tree.

This is the property that keeps multi-agent debugging tractable. A failure deep in a child loop produces a trace that links back to the parent's turn; the timeline view shows the full fan-out. Without this, "the engineer crashed mid-review" would be a needle in a multi-process haystack.

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
