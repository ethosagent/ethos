---
title: "Why split tools per action instead of one multiplexed tool?"
description: "When to split a domain into N tools (kanban_create, kanban_list, ...) vs. unify behind one tool with an action arg (mcp). The heuristic and why."
kind: explanation
audience: developer
slug: tool-shape
updated: 2026-05-17
---

# Why split tools per action instead of one multiplexed tool?

Ethos uses two patterns for tools with multiple actions:

- **Split**: one tool per action (e.g. `kanban_create`, `kanban_update`, `kanban_list`)
- **Unified**: one tool with an `action` parameter (e.g. `mcp_call(action, ...)`)

Both exist in the codebase today. This document establishes when to use each.

## The heuristic

**Split** when:
- Actions have distinct semantics that benefit from separate descriptions
- The agent calls these tools frequently (LLM tool-choice is faster with distinct names)
- Actions have different parameters (avoids one-of-many schema confusion)
- Examples: kanban (13 tools), todo, process management, cron

**Unified** when:
- Many low-frequency actions share setup/auth/context
- The action set is large (>15) and the LLM rarely needs more than 2-3 per turn
- Actions come from an external system (MCP, plugin) where the boundary is defined elsewhere
- Examples: MCP servers, future platform integrations (Spotify, etc.)

## Decision matrix

| Signal | → Split | → Unified |
|--------|---------|-----------|
| Agent calls it every turn | ✓ | |
| 3-8 distinct actions | ✓ | |
| Actions share no parameters | ✓ | |
| 15+ actions from one service | | ✓ |
| External schema (MCP, OpenAPI) | | ✓ |
| Actions share auth/connection | | ✓ |

## Current state

| Package | Pattern | Actions | Notes |
|---------|---------|---------|-------|
| tools-kanban | Split | 13 | Correct: high-frequency, distinct semantics |
| tools-todo | Split | 5 | Correct: distinct params per action |
| tools-process | Split | 5 | Correct: start/stop/list are fundamentally different |
| tools-cron | Split | 4 | Correct: CRUD on schedules |
| tools-mcp | Unified | N (dynamic) | Correct: external schemas, auth-gated |
| tools-memory | Split | 6 | Correct: read/write/search have different shapes |

## What this means for new tools

When adding a new tool package, pick the pattern before writing code. Document your choice in the package's source header comment. If you're unsure, default to **split** — it's easier for the LLM to reason about and easier to restrict via personality toolsets.

## What this does NOT mean

This is not a migration mandate. Existing tools stay as-is unless a separate plan justifies the churn. This document records the principle so future work is consistent.
