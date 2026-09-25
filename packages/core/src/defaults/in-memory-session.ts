import type {
  AgentEvent,
  CompressionEvent,
  MessagePage,
  MessagePageOptions,
  SearchResult,
  Session,
  SessionFilter,
  SessionStore,
  SessionUsage,
  StoredDecision,
  StoredMessage,
} from '@ethosagent/types';

export class InMemorySessionStore implements SessionStore {
  private sessions = new Map<string, Session>();
  private messages = new Map<string, StoredMessage[]>();
  private compressions = new Map<string, CompressionEvent[]>();
  private decisions = new Map<string, StoredDecision[]>();
  private turnState = new Map<string, { turnCount: number; lastCompactionTurn: number }>();
  private idCounter = 0;

  async createSession(data: Omit<Session, 'id' | 'createdAt' | 'updatedAt'>): Promise<Session> {
    const session: Session = {
      ...data,
      id: `session_${++this.idCounter}`,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.sessions.set(session.id, session);
    this.messages.set(session.id, []);
    return session;
  }

  async getSession(id: string): Promise<Session | null> {
    return this.sessions.get(id) ?? null;
  }

  async getSessionByKey(key: string): Promise<Session | null> {
    for (const s of this.sessions.values()) {
      if (s.key === key) return s;
    }
    return null;
  }

  async updateSession(id: string, patch: Partial<Session>): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Session not found: ${id}`);
    // A session's personality is bound at creation and immutable thereafter.
    // Binding an unset one is allowed; re-pointing a bound one never is.
    if (
      patch.personalityId !== undefined &&
      session.personalityId != null &&
      patch.personalityId !== session.personalityId
    ) {
      throw new Error(
        `Session ${id} is bound to personality "${session.personalityId}" and cannot be changed to "${patch.personalityId}".`,
      );
    }
    this.sessions.set(id, { ...session, ...patch, updatedAt: new Date() });
  }

  async deleteSession(id: string): Promise<void> {
    this.sessions.delete(id);
    this.messages.delete(id);
    this.compressions.delete(id);
    this.decisions.delete(id);
    this.turnState.delete(id);
  }

  async listSessions(filter?: SessionFilter): Promise<Session[]> {
    let results = [...this.sessions.values()];
    if (filter?.platform) results = results.filter((s) => s.platform === filter.platform);
    if (filter?.personalityId)
      results = results.filter((s) => s.personalityId === filter.personalityId);
    if (filter?.workingDir) results = results.filter((s) => s.workingDir === filter.workingDir);
    if (filter?.parentSessionId)
      results = results.filter((s) => s.parentSessionId === filter.parentSessionId);
    if (filter?.since) {
      const since = filter.since;
      results = results.filter((s) => s.createdAt >= since);
    }
    results.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const offset = filter?.offset ?? 0;
    const limit = filter?.limit ?? results.length;
    return results.slice(offset, offset + limit);
  }

  async appendMessage(data: Omit<StoredMessage, 'id' | 'timestamp'>): Promise<StoredMessage> {
    const message: StoredMessage = {
      ...data,
      id: `msg_${++this.idCounter}`,
      timestamp: new Date(),
    };
    const list = this.messages.get(data.sessionId) ?? [];
    list.push(message);
    this.messages.set(data.sessionId, list);
    return message;
  }

  async getMessages(
    sessionId: string,
    options?: { limit?: number; offset?: number },
  ): Promise<StoredMessage[]> {
    const all = this.messages.get(sessionId) ?? [];
    const offset = options?.offset ?? 0;
    // Return most-recent messages: trim from the tail, then skip `offset` from the end
    const end = all.length - offset;
    const start = options?.limit ? Math.max(0, end - options.limit) : 0;
    return all.slice(start, end);
  }

  // The twin of extensions/session-sqlite/src/message-page.ts: the same page
  // semantics (documented on `MessagePageOptions`), pinned for both stores by
  // extensions/session-sqlite/src/__tests__/message-page.test.ts. Array order
  // is insertion order, which is the order `getMessages` above returns.
  async getMessagePage(
    sessionId: string,
    options: MessagePageOptions,
  ): Promise<MessagePage | null> {
    const { turns, beforeMessageId, maxBytes } = options;
    if (!Number.isInteger(turns) || turns < 1) {
      throw new RangeError(`turns must be an integer >= 1, got ${turns}`);
    }
    const all = this.messages.get(sessionId) ?? [];
    let end = all.length;
    if (beforeMessageId !== undefined) {
      end = all.findIndex((m) => m.id === beforeMessageId);
      if (end < 0) return null;
    }

    const accepted: StoredMessage[][] = [];
    let turn: StoredMessage[] = [];
    let turnBytes = 0;
    let total = 0;
    let hasMore = false;
    for (let i = end - 1; i >= 0; i--) {
      const m = all[i];
      if (!m) continue;
      turn.push(m);
      turnBytes +=
        Buffer.byteLength(m.content) +
        (m.toolCalls ? Buffer.byteLength(JSON.stringify(m.toolCalls)) : 0);
      if (m.role !== 'user') continue;
      if (
        accepted.length === turns ||
        (accepted.length > 0 && maxBytes !== undefined && total + turnBytes > maxBytes)
      ) {
        hasMore = true;
        turn = [];
        break;
      }
      accepted.push(turn);
      total += turnBytes;
      turn = [];
      turnBytes = 0;
    }

    // Leftover rows precede every user row: they count toward the oldest turn.
    if (turn.length > 0) {
      const oldest = accepted.at(-1);
      if (!oldest) {
        accepted.push(turn);
      } else if (accepted.length === 1 || maxBytes === undefined || total + turnBytes <= maxBytes) {
        oldest.push(...turn);
      } else {
        accepted.pop();
        hasMore = true;
      }
    }

    return { messages: accepted.flat().reverse(), hasMore };
  }

  /** Twin of the SQLite store's (extensions/session-sqlite/src/decisions.ts):
   *  refuses an unknown session, as the foreign key does there. */
  async appendDecision(
    sessionId: string,
    event: Extract<AgentEvent, { type: 'decision' }>,
  ): Promise<StoredDecision> {
    if (!this.sessions.has(sessionId)) throw new Error(`session not found: ${sessionId}`);
    const rows = this.decisions.get(sessionId) ?? [];
    const row: StoredDecision = {
      sessionId,
      seq: (rows.at(-1)?.seq ?? 0) + 1,
      event: structuredClone(event),
      createdAt: new Date(),
    };
    rows.push(row);
    this.decisions.set(sessionId, rows);
    return row;
  }

  async getDecisions(
    sessionId: string,
    filter?: { toolCallIds?: readonly string[]; traceIds?: readonly string[] },
  ): Promise<StoredDecision[]> {
    const rows = this.decisions.get(sessionId) ?? [];
    if (!filter) return [...rows];
    const calls = new Set(filter.toolCallIds ?? []);
    const traces = new Set(filter.traceIds ?? []);
    return rows.filter(
      (r) =>
        (r.event.toolCallId !== undefined && calls.has(r.event.toolCallId)) ||
        (r.event.traceId !== undefined && traces.has(r.event.traceId)),
    );
  }

  async updateUsage(sessionId: string, delta: Partial<SessionUsage>): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const usage = { ...session.usage };
    for (const [k, v] of Object.entries(delta) as [keyof SessionUsage, number][]) {
      (usage[k] as number) += v;
    }
    this.sessions.set(sessionId, { ...session, usage, updatedAt: new Date() });
  }

  async search(
    query: string,
    options?: {
      limit?: number;
      sessionId?: string;
      since?: Date;
      until?: Date;
    },
  ): Promise<SearchResult[]> {
    const results: SearchResult[] = [];
    const lower = query.toLowerCase();
    for (const [sessionId, msgs] of this.messages.entries()) {
      if (options?.sessionId && sessionId !== options.sessionId) continue;
      for (const msg of msgs) {
        if (options?.since && msg.timestamp < options.since) continue;
        if (options?.until && msg.timestamp > options.until) continue;
        const idx = msg.content.toLowerCase().indexOf(lower);
        if (idx >= 0) {
          results.push({
            sessionId,
            messageId: msg.id,
            snippet: msg.content.slice(Math.max(0, idx - 50), idx + 150),
            score: 1,
            timestamp: msg.timestamp,
          });
        }
      }
    }
    results.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
    return results.slice(0, options?.limit ?? 20);
  }

  async recordCompression(
    event: Omit<CompressionEvent, 'id' | 'createdAt'>,
  ): Promise<CompressionEvent> {
    const full: CompressionEvent = {
      ...event,
      id: `compression_${++this.idCounter}`,
      createdAt: new Date(),
    };
    const list = this.compressions.get(event.sessionId) ?? [];
    list.push(full);
    this.compressions.set(event.sessionId, list);
    return full;
  }

  async listCompressions(sessionId: string): Promise<CompressionEvent[]> {
    return [...(this.compressions.get(sessionId) ?? [])];
  }

  async recordTurnStart(
    sessionId: string,
  ): Promise<{ turnNumber: number; lastCompactionTurn: number }> {
    const state = this.turnState.get(sessionId) ?? { turnCount: 0, lastCompactionTurn: 0 };
    state.turnCount += 1;
    this.turnState.set(sessionId, state);
    return { turnNumber: state.turnCount, lastCompactionTurn: state.lastCompactionTurn };
  }

  async recordCompactionTurn(sessionId: string, turnNumber: number): Promise<void> {
    const state = this.turnState.get(sessionId) ?? { turnCount: 0, lastCompactionTurn: 0 };
    state.lastCompactionTurn = turnNumber;
    this.turnState.set(sessionId, state);
  }

  async pruneOldSessions(olderThan: Date): Promise<number> {
    let count = 0;
    for (const [id, session] of this.sessions.entries()) {
      // Same rule as SQLiteSessionStore.pruneOldSessions: a session holding a
      // message at or after the cutoff is kept, whatever its `updatedAt`.
      const recent = (this.messages.get(id) ?? []).some((m) => m.timestamp >= olderThan);
      if (session.updatedAt < olderThan && !recent) {
        this.sessions.delete(id);
        this.messages.delete(id);
        this.decisions.delete(id);
        count++;
      }
    }
    return count;
  }

  async undoTurns(_sessionId: string, _n: number): Promise<number> {
    return 0;
  }

  async vacuum(): Promise<void> {
    // No-op for in-memory store
  }
}
