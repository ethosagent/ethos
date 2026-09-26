// reach-and-containment Part 1 (C4/C6) — the loop-native `tool_search`.
//
// `tool_search` is NOT a registered Tool (D1-8): it reads and writes the
// loop's per-session loaded set, which `ToolContext` (drift-gated) cannot
// reach. `processTools` splits these calls out of the batch before
// `executeParallel` and hands them here. It can only ever return names from
// `ToolLoadingState.universe` — the `toDefinitions(allowedTools, filterOpts)`
// output of turn setup — so it cannot surface, load or run anything outside
// the allowlist; execution of what it finds still goes through the unchanged
// allowlist check in `DefaultToolRegistry.executeParallel`.

import type { AgentEvent, MessageContent, SessionStore } from '@ethosagent/types';
import {
  MAX_LOADED_TOOLS,
  noteLoaded,
  searchTools,
  TOOL_SEARCH_NAME,
  type ToolLoadingState,
} from '../tool-loading';
import type { CompletedToolCall } from './stream-step';

/**
 * C6 — persist the loaded set as `Session.metadata.loadedTools`. Read-merge-
 * write because `SessionStore.updateSession` REPLACES `metadata` wholesale
 * (`SQLiteSessionStore.updateSession`, extensions/session-sqlite). Called from
 * the turn's sequential dispatch only, so one loop never races itself on a
 * session; two processes on one session can still lose a load (plan §1.7),
 * which D1-1 heals on the next direct call.
 */
export async function persistLoaded(
  session: SessionStore,
  sessionId: string,
  loaded: readonly string[],
): Promise<void> {
  const current = await session.getSession(sessionId);
  await session.updateSession(sessionId, {
    metadata: { ...(current?.metadata ?? {}), loadedTools: [...loaded] },
  });
}

function firstLine(text: string): string {
  return (text.split('\n')[0] ?? '').trim();
}

function queryOf(args: unknown): { query: string; limit: unknown } {
  if (typeof args !== 'object' || args === null) return { query: '', limit: undefined };
  const obj = args as Record<string, unknown>;
  return { query: typeof obj.query === 'string' ? obj.query : '', limit: obj.limit };
}

/** Split well-formed `tool_search` calls from the rest of the batch. A call
 *  whose arguments failed to parse stays in the batch and is rejected there
 *  like any other malformed call. */
export function splitToolSearchCalls(calls: CompletedToolCall[]): {
  search: CompletedToolCall[];
  rest: CompletedToolCall[];
} {
  const search: CompletedToolCall[] = [];
  const rest: CompletedToolCall[] = [];
  for (const tc of calls) {
    if (tc.toolName === TOOL_SEARCH_NAME && tc.parseError === undefined) search.push(tc);
    else rest.push(tc);
  }
  return { search, rest };
}

/**
 * Run each `tool_search` call: search the not-yet-pinned universe, append the
 * hits to the loaded set (D1-2: capped, never evicted), persist, and answer
 * with one `tool_result` per `tool_use` (the Anthropic pairing contract).
 * Returns the tool_result blocks for the next user message.
 */
export async function* runToolSearchCalls(
  deps: { session: SessionStore },
  ctx: { sessionId: string; traceId: string | undefined; toolLoading: ToolLoadingState },
  calls: CompletedToolCall[],
): AsyncGenerator<AgentEvent, MessageContent[]> {
  const { plan, universe } = ctx.toolLoading;
  const universeNames = new Set(universe.map((d) => d.name));
  const searchable = universe.filter((d) => !plan.pinned.has(d.name));
  const blocks: MessageContent[] = [];
  for (const tc of calls) {
    const started = Date.now();
    yield { type: 'tool_start', toolCallId: tc.toolCallId, toolName: tc.toolName, args: tc.args };
    const { query, limit } = queryOf(tc.args);
    const hits = searchTools(query, searchable, limit);
    const atCap = plan.loaded.length >= MAX_LOADED_TOOLS;
    const added = atCap
      ? []
      : noteLoaded(
          plan,
          universeNames,
          hits.map((h) => h.name),
        );
    if (added.length > 0) await persistLoaded(deps.session, ctx.sessionId, plan.loaded);

    const lines = hits.map((h) => `- ${h.name} — ${firstLine(h.description)}`);
    const content =
      hits.length === 0
        ? `No tools matched "${query}". Try other keywords.`
        : atCap
          ? `Found ${hits.length} tool(s). The loaded-tool limit (${MAX_LOADED_TOOLS}) is reached, ` +
            `so their schemas will not be added, but you can call them directly by name:\n${lines.join('\n')}`
          : `Found ${hits.length} tool(s); they are callable from your next step:\n${lines.join('\n')}`;

    await deps.session.appendMessage({
      sessionId: ctx.sessionId,
      role: 'tool_result',
      content,
      toolCallId: tc.toolCallId,
      toolName: tc.toolName,
      traceId: ctx.traceId,
      isError: false,
    });
    blocks.push({ type: 'tool_result', tool_use_id: tc.toolCallId, content, is_error: false });
    yield {
      type: 'tool_end',
      toolCallId: tc.toolCallId,
      toolName: tc.toolName,
      ok: true,
      durationMs: Date.now() - started,
      result: content,
    };
  }
  return blocks;
}

/**
 * `processTools`' entry point: with loading inactive, the whole batch passes
 * through untouched and no search runs; with it active, well-formed
 * `tool_search` calls are answered here and removed from the batch.
 */
export async function* answerToolSearch(
  deps: { session: SessionStore },
  ctx: {
    sessionId: string;
    traceId: string | undefined;
    toolLoading?: ToolLoadingState;
    completedToolCalls: CompletedToolCall[];
  },
): AsyncGenerator<
  AgentEvent,
  { batchCalls: CompletedToolCall[]; searchResults: MessageContent[] }
> {
  const toolLoading = ctx.toolLoading;
  if (!toolLoading) return { batchCalls: ctx.completedToolCalls, searchResults: [] };
  const { search, rest } = splitToolSearchCalls(ctx.completedToolCalls);
  const searchResults = yield* runToolSearchCalls(
    deps,
    { sessionId: ctx.sessionId, traceId: ctx.traceId, toolLoading },
    search,
  );
  return { batchCalls: rest, searchResults };
}

/**
 * D1-1 — an allowed-but-unloaded tool called directly has already run (the
 * allowlist check in `executeParallel` decided that); append it so the next
 * step carries its schema. Only universe names are ever appended, so a call
 * `executeParallel` refused as outside the allowlist is never loaded. No-op
 * when loading is inactive.
 */
export async function recordDirectLoads(
  deps: { session: SessionStore },
  ctx: { sessionId: string; toolLoading?: ToolLoadingState },
  ran: ReadonlyArray<{ name: string }>,
): Promise<void> {
  if (!ctx.toolLoading) return;
  const { plan, universe } = ctx.toolLoading;
  const names = ran.map((r) => r.name);
  const added = noteLoaded(plan, new Set(universe.map((d) => d.name)), names);
  if (added.length > 0) await persistLoaded(deps.session, ctx.sessionId, plan.loaded);
}
