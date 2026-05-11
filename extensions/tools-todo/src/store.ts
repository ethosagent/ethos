import type { TodoItem, TodoList, TodoStatus } from '@ethosagent/types';

// In-memory single-process todo store. One Map keyed by `ToolContext.sessionKey`;
// `/new` mints a fresh sessionKey so the prior list becomes unreachable for
// free. Bounded by a 16-session LRU so a long-running gateway process
// doesn't grow without bound across many `/new`s.
//
// Per-session async mutex serializes mutations — `ToolRegistry.executeParallel`
// can dispatch two `todo_add` calls in one turn, and without the chain both
// would read the same "next id" snapshot and one item would silently lose
// its slot. Reads (`list`) skip the chain and return a snapshot.

const MAX_SESSIONS = 16;
const NOTES_MAX_CHARS = 500;
const NOTES_TRUNC_SUFFIX = '…';

export type TodoInput = { content: string; activeForm: string };

export interface TodoUpdate {
  status?: TodoStatus;
  content?: string;
  activeForm?: string;
  /** Pass `undefined` to leave notes untouched; pass `''` (or any string) to set. */
  notes?: string;
}

export type AddPosition = 'start' | 'end' | number;

export interface AddResult {
  id: string;
  notes_truncated?: true;
}

export interface UpdateResult {
  ok: true;
  notes_truncated?: true;
}

export class MultipleInProgressError extends Error {
  readonly code = 'MULTIPLE_IN_PROGRESS' as const;
  constructor(public readonly existingId: string) {
    super(`Another task (${existingId}) is already in_progress`);
  }
}

export class TodoNotFoundError extends Error {
  readonly code = 'NOT_FOUND' as const;
  constructor(public readonly id: string) {
    super(`No task with id "${id}"`);
  }
}

interface SessionState {
  items: TodoItem[];
  nextId: number;
}

/**
 * Truncate `notes` to `NOTES_MAX_CHARS` (replacing the tail with `…` when over).
 * Returns the (possibly truncated) value and a flag indicating whether it was
 * shortened so callers can surface `notes_truncated: true` to the LLM.
 */
function clipNotes(notes: string | undefined): { value: string | undefined; truncated: boolean } {
  if (notes === undefined) return { value: undefined, truncated: false };
  if (notes.length <= NOTES_MAX_CHARS) return { value: notes, truncated: false };
  return {
    value: notes.slice(0, NOTES_MAX_CHARS - NOTES_TRUNC_SUFFIX.length) + NOTES_TRUNC_SUFFIX,
    truncated: true,
  };
}

export class InMemoryTodoStore {
  private readonly sessions = new Map<string, SessionState>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly maxSessions: number;
  private readonly now: () => string;

  constructor(opts: { maxSessions?: number; now?: () => string } = {}) {
    this.maxSessions = opts.maxSessions ?? MAX_SESSIONS;
    this.now = opts.now ?? (() => new Date().toISOString());
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /** Snapshot read — bypasses the mutex; returns a fresh array copy. */
  list(sessionKey: string, filter: 'open' | 'all' | TodoStatus = 'open'): TodoItem[] {
    const state = this.sessions.get(sessionKey);
    if (!state) return [];
    if (filter === 'all') return state.items.slice();
    if (filter === 'open') return state.items.filter((i) => i.status !== 'completed');
    return state.items.filter((i) => i.status === filter);
  }

  /** Replace the whole list. Resets id counter to 1. */
  set(sessionKey: string, todos: TodoInput[]): Promise<{ count: number; ids: string[] }> {
    return this.runSerial(sessionKey, () => {
      const state = this.touch(sessionKey, { reset: true });
      const ts = this.now();
      const ids: string[] = [];
      for (const t of todos) {
        const id = `t${state.nextId++}`;
        ids.push(id);
        state.items.push({
          id,
          content: t.content,
          activeForm: t.activeForm,
          status: 'pending',
          created_at: ts,
          updated_at: ts,
        });
      }
      return { count: state.items.length, ids };
    });
  }

  /** Append (or insert) a single task. Position clamps to [0, len]. */
  add(
    sessionKey: string,
    input: TodoInput & { notes?: string; position?: AddPosition },
  ): Promise<AddResult> {
    return this.runSerial(sessionKey, () => {
      const state = this.touch(sessionKey);
      const ts = this.now();
      const id = `t${state.nextId++}`;
      const { value: notes, truncated } = clipNotes(input.notes);
      const item: TodoItem = {
        id,
        content: input.content,
        activeForm: input.activeForm,
        status: 'pending',
        ...(notes !== undefined ? { notes } : {}),
        created_at: ts,
        updated_at: ts,
      };

      const idx = resolvePosition(input.position, state.items.length);
      state.items.splice(idx, 0, item);

      return truncated ? { id, notes_truncated: true as const } : { id };
    });
  }

  /**
   * Patch one task. Undefined fields leave existing values alone. Status flip
   * to `in_progress` rejects if another task already holds that status.
   */
  update(sessionKey: string, id: string, patch: TodoUpdate): Promise<UpdateResult> {
    return this.runSerial(sessionKey, () => {
      const state = this.touch(sessionKey);
      const item = state.items.find((i) => i.id === id);
      if (!item) throw new TodoNotFoundError(id);

      if (patch.status === 'in_progress' && item.status !== 'in_progress') {
        const existing = state.items.find((i) => i.status === 'in_progress');
        if (existing) throw new MultipleInProgressError(existing.id);
      }

      const ts = this.now();
      if (patch.status !== undefined) {
        const wasCompleted = item.status === 'completed';
        item.status = patch.status;
        if (patch.status === 'completed' && !wasCompleted) item.completed_at = ts;
        else if (patch.status !== 'completed') item.completed_at = undefined;
      }
      if (patch.content !== undefined) item.content = patch.content;
      if (patch.activeForm !== undefined) item.activeForm = patch.activeForm;

      let truncated = false;
      if (patch.notes !== undefined) {
        const clipped = clipNotes(patch.notes);
        item.notes = clipped.value;
        truncated = clipped.truncated;
      }
      item.updated_at = ts;

      return truncated
        ? { ok: true as const, notes_truncated: true as const }
        : { ok: true as const };
    });
  }

  /** Empty the list and reset the id counter. */
  clear(sessionKey: string): Promise<{ cleared: number }> {
    return this.runSerial(sessionKey, () => {
      const state = this.sessions.get(sessionKey);
      if (!state) return { cleared: 0 };
      const cleared = state.items.length;
      state.items = [];
      state.nextId = 1;
      return { cleared };
    });
  }

  /** Test-only — peek at the snapshot for assertions. */
  asTodoList(sessionKey: string): TodoList {
    return { sessionId: sessionKey, items: this.list(sessionKey, 'all') };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private touch(sessionKey: string, opts: { reset?: boolean } = {}): SessionState {
    let state = this.sessions.get(sessionKey);
    if (!state) {
      state = { items: [], nextId: 1 };
      this.sessions.set(sessionKey, state);
      this.evict();
    } else if (opts.reset) {
      state.items = [];
      state.nextId = 1;
      // Move to most-recent slot so eviction tracks recency for active sessions.
      this.sessions.delete(sessionKey);
      this.sessions.set(sessionKey, state);
    }
    return state;
  }

  private evict(): void {
    while (this.sessions.size > this.maxSessions) {
      const oldest = this.sessions.keys().next().value;
      if (oldest === undefined) return;
      this.sessions.delete(oldest);
    }
  }

  /**
   * Chain `fn` onto the per-session promise so two concurrent mutations
   * serialize. Failures propagate to the caller but don't break the chain
   * for subsequent callers.
   */
  private runSerial<R>(sessionKey: string, fn: () => R | Promise<R>): Promise<R> {
    const prev = this.locks.get(sessionKey) ?? Promise.resolve();
    const next = prev.then(
      () => fn(),
      () => fn(),
    );
    this.locks.set(
      sessionKey,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }
}

function resolvePosition(position: AddPosition | undefined, len: number): number {
  if (position === 'start') return 0;
  if (position === undefined || position === 'end') return len;
  if (Number.isFinite(position)) return Math.max(0, Math.min(len, Math.floor(position)));
  return len;
}
