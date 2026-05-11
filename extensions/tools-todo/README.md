# @ethosagent/tools-todo

In-process scratch todo list for a single personality to track its own
progress within one session. No persistence, no cross-personality
coordination — when the process exits, all lists vanish; when `/new`
mints a fresh `sessionKey`, the prior list becomes unreachable.

For durable single-agent notes use `memory_write`; for multi-personality
coordination, the upcoming **kanban** surface is the right tool.

## Tools (five, all in `toolset: 'todo'`)

| Name | Signature |
|---|---|
| `todo_set`    | `({ todos: [{ content, activeForm }, ...] }) → { count, ids }` |
| `todo_add`    | `({ content, activeForm, notes?, position? }) → { id, notes_truncated? }` |
| `todo_update` | `({ id, status?, content?, activeForm?, notes? }) → { ok, notes_truncated? }` |
| `todo_list`   | `({ filter? }) → TodoItem[]` (default `filter: 'open'`) |
| `todo_clear`  | `() → { cleared }` |

### Key invariants

- **Exactly one** task may be `in_progress` at a time. `todo_update` rejects a
  second `in_progress` flip with `MULTIPLE_IN_PROGRESS`.
- IDs are monotonic per session — `t1`, `t2`, … — and reset to `t1` on
  `todo_set` / `todo_clear` (both "start over" operations).
- `notes` is capped at 500 chars; longer values are truncated with `…` and the
  response carries `notes_truncated: true` so the LLM can rewrite if it cares.
- `todo_list({})` defaults to `filter: 'open'` (= pending + in_progress). The
  full list (including completed) requires explicit `filter: 'all'` — this
  prevents the model from re-doing finished work when completed items would
  otherwise show on every turn (Hermes's documented regression).

## Opting in

Add the tool names to a personality's `toolset.yaml`:

```yaml
- todo_set
- todo_add
- todo_update
- todo_list
- todo_clear
```

The shipped `engineer` personality includes them. The framework injects no
system prompt — the personality calls `todo_list` explicitly when it needs to
remember what's pending.

## Storage

`InMemoryTodoStore` — a `Map<sessionKey, TodoList>` inside this package, one
instance per process. Bounded by a 16-session LRU so a long-running gateway
process doesn't grow without bound across many `/new`s. Per-session mutex
chain serializes mutations so `executeParallel` of two `todo_add` calls in one
turn both land with distinct ids.
