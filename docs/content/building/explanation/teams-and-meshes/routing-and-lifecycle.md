---
title: "Why does a mesh route by capability and restart a bounded number of times?"
description: "Capability routing, heartbeat, bounded restarts, sessions and observability."
kind: explanation
audience: developer
updated: 2026-11-03
---

## Context

This page covers how a mesh routes work and how its members live, restart and are observed.

## Discussion

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

### Observability across a mesh

Every member writes to the same observability database (`~/.ethos/observability.db` via `extensions/observability-sqlite/`). The traces are keyed by `sessionId`, with a parent/child relationship for delegated turns. The CLI's observability commands (`ethos obs traces`) walk the tree.

This is the property that keeps multi-agent debugging tractable. A failure deep in a child loop produces a trace that links back to the parent's turn; the timeline view shows the full fan-out. Without this, "the engineer crashed mid-review" would be a needle in a multi-process haystack.

## Trade-offs

See [Trade-offs](../teams-and-meshes.md#trade-offs) on [When should you use a mesh of agents, not one?](../teams-and-meshes.md).

## See also

- [When should you use a mesh of agents, not one?](../teams-and-meshes.md) — the parent page.
