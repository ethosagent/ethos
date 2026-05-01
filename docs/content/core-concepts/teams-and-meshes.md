---
title: Teams and Meshes
description: Run multiple personalities as one named team, with supervisor-managed lifecycle and mesh-scoped routing.
sidebar_position: 5
---

# Teams and Meshes

Ethos team mode lets you run multiple agent personalities together as one managed unit.

Think of it this way:

- The **mesh** is the live discovery/routing layer (`~/.ethos/meshes/<name>/registry.json`)
- A **team** is a declarative config (`team.yaml`) that says which members should be running in a mesh
- The **team supervisor** is the process that keeps those members alive and writes runtime state

This gives you one-command lifecycle control for multi-agent workflows:

```bash
ethos team start <name>
ethos team status <name>
ethos team stop <name>
```

## Why this exists

Before team mode, running multi-agent setups meant manually managing ports and terminals for each `ethos serve` process.

Team mode adds:

- Single command boot/shutdown
- Supervisor-managed restart behavior
- Shared runtime visibility (`status`, `logs`)
- Mesh isolation between teams by default

## Team manifest

Team manifests live at either:

- `./team.yaml` (project-scoped, takes precedence when name matches)
- `~/.ethos/teams/<name>.yaml` (user-scoped)

Example:

```yaml
name: demo
description: Demo team
domain_capabilities:
  - research
  - code
dispatch_mode: self-routing
mesh: demo
members:
  - personality: researcher
    auto_restart: true
  - personality: engineer
    auto_restart: true
```

Key fields:

- `name` - team id, and default mesh name if `mesh` is omitted
- `mesh` - optional explicit mesh name (use shared value to let teams share one mesh)
- `members[].personality` - personality id per member
- `members[].auto_restart` - restart member after crash
- `dispatch_mode` / `coordinator` - dispatch strategy metadata for team behavior

## Team commands

```bash
ethos team create demo
ethos team demo add researcher
ethos team demo add engineer

ethos team start demo
ethos team status demo
ethos team logs demo --member researcher
ethos team stop demo
```

Important: member add/remove syntax is `ethos team <name> add <personality>`, not `ethos team add <personality>`.

## Mesh commands

```bash
ethos mesh list
ethos mesh status demo
ethos mesh create scratch
ethos mesh destroy scratch
```

Use these when you want visibility/control at the mesh layer rather than team layer.

## Use team mode in chat

Starting a team does not automatically switch your active chat target.

Set team context explicitly:

```bash
ethos set team demo
ethos chat
```

To switch back to a single personality:

```bash
ethos set personality researcher
```

## Runtime files and logs

- Team manifests: `~/.ethos/teams/*.yaml`
- Runtime snapshot: `~/.ethos/teams/<name>.runtime.json`
- Supervisor event log: `~/.ethos/logs/mesh-supervisor.log`
- Member logs: `~/.ethos/logs/team/<name>/<personality>.log`

## Failure states you may see

- `restarting` - member crashed and supervisor is backing off before retry
- `failed` - member hit max restart failures within window and supervisor gave up
- `stopped` - no active runtime/supervisor for this team

If members fail repeatedly, check member logs first:

```bash
ethos team logs <name> --member <personality>
```
