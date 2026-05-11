// In-session todo list — single-personality working memory. Lives in
// process memory only; no file is ever written. `/new` mints a fresh
// sessionKey so the prior list becomes unreachable without explicit
// cleanup. Durable multi-personality coordination is the kanban surface
// (separate plan); persistent single-agent notes go via memory_write.

export type TodoStatus = 'pending' | 'in_progress' | 'completed';

export interface TodoItem {
  /** Monotonic per-session id: `t1`, `t2`, … Resets on todo_set / todo_clear. */
  id: string;
  /** Imperative — "Run the migration". */
  content: string;
  /** Present-continuous form, displayed while status is `in_progress`. */
  activeForm: string;
  status: TodoStatus;
  /** Optional free-form context (max 500 chars; truncated with `…`). */
  notes?: string;
  /** ISO 8601 timestamps. `completed_at` populated only when status flips to completed. */
  created_at: string;
  updated_at: string;
  completed_at?: string;
}

export interface TodoList {
  sessionId: string;
  items: TodoItem[];
}
