import { createHash } from 'node:crypto';
import {
  compactionFromStoredRow,
  encodeCompactionEnvelope,
  flattenCompactionEnvelopes,
  type Message,
  type MessageContent,
  type StoredMessage,
} from '@ethosagent/types';
import { ghostSkillMarker, skillCallsFromHistory } from './ghost-skills';

/**
 * What a blank assistant turn replays as. Anthropic rejects an assistant
 * message with empty (or whitespace-only) text anywhere but the final position,
 * and a replayed row is never final — the next user message follows it. Used by
 * {@link toLLMMessages} for a stored empty model reply, and by
 * `persistReturnDirect` (./stages/return-direct.ts) as the answer to an empty
 * returnDirect value. Pinned by __tests__/return-direct-history.test.ts.
 *
 * The same API rejects a whitespace-only text BLOCK, so blank text beside a
 * tool_use is dropped rather than sent — here and in `streamStep`'s in-turn
 * message (./stages/stream-step.ts). Such a message still has its tool_use, so
 * it never needs this placeholder. Pinned by __tests__/blank-assistant-text.test.ts.
 */
export const EMPTY_ASSISTANT_TEXT = '(no output)';

/** Options for {@link dedupHistory}. */
export interface DedupOpts {
  /**
   * Item 7 — emit ghost-skill markers for deduped `get_skill` results. Set only
   * for `skills.injection_mode: 'index'` personalities; under `'full'` the skill
   * body lives in the static prefix and is never pruned, so no marker is needed
   * and adding one would be noise.
   */
  skillMarkers?: boolean;
}

// Q1 — tool-result dedup. A coordinator that re-reads the same file across
// turns stores one tool_result per read; over a long session that is pure
// token waste. Before building the LLM-facing history, collapse exact-
// duplicate tool results — same tool, same args, same output — keeping the
// FIRST (oldest) copy intact and replacing later ones with a placeholder
// that points BACKWARD at it. Pointing backward preserves causality: the
// assistant turn that followed a later read can still see the content
// earlier in the transcript. The tool_result row stays attached to its
// tool_use (Anthropic contract); only the content string changes.
export function dedupHistory(history: StoredMessage[], opts?: DedupOpts): StoredMessage[] {
  // tool_use id → serialized args, harvested from assistant messages so a
  // tool_result can be keyed by the arguments that produced it.
  const argsByToolCallId = new Map<string, string>();
  for (const msg of history) {
    if (msg.role === 'assistant' && msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        argsByToolCallId.set(tc.id, JSON.stringify(tc.input ?? null));
      }
    }
  }

  // Fingerprint each tool_result and group occurrences by identity.
  const occurrences = new Map<string, number[]>();
  history.forEach((msg, idx) => {
    if (msg.role !== 'tool_result') return;
    const toolName = msg.toolName ?? '';
    const argsHash = msg.toolCallId ? (argsByToolCallId.get(msg.toolCallId) ?? '') : '';
    const fingerprint = createHash('sha256')
      .update(`${toolName}\x00${argsHash}\x00${msg.content.trim()}`)
      .digest('hex');
    const list = occurrences.get(fingerprint);
    if (list) list.push(idx);
    else occurrences.set(fingerprint, [idx]);
  });

  // For every fingerprint seen more than once, keep the first occurrence and
  // replace every later one with a placeholder pointing back at it.
  //
  // Item 7 — a `get_skill` body is the one result where the backward pointer is
  // not enough: compaction may already have dropped the copy it points at, and
  // the skill's index stub still tells the model it HAS the skill. Those get a
  // ghost-skill marker naming the skill instead of the bare pointer.
  const skillCalls = opts?.skillMarkers ? skillCallsFromHistory(history) : undefined;
  const replacement = new Map<number, string>();
  for (const indices of occurrences.values()) {
    if (indices.length < 2) continue;
    const oldest = indices[0];
    if (oldest === undefined) continue;
    const oldestId = history[oldest]?.toolCallId ?? String(oldest);
    for (const idx of indices.slice(1)) {
      const toolCallId = history[idx]?.toolCallId;
      const skillName = toolCallId ? skillCalls?.get(toolCallId) : undefined;
      replacement.set(
        idx,
        skillName
          ? ghostSkillMarker(skillName)
          : `[deduped — identical to earlier result, see tool_use id ${oldestId}]`,
      );
    }
  }

  if (replacement.size === 0) return history;
  return history.map((msg, idx) => {
    const placeholder = replacement.get(idx);
    return placeholder !== undefined ? { ...msg, content: placeholder } : msg;
  });
}

/**
 * The mutable block list of `msg` when it is a user message holding a batch of
 * tool results, else `undefined`.
 *
 * Identifying a batch by "ends in a tool_result" rather than "content is an
 * array" matters since user turns can carry inline vision blocks: those are
 * array-shaped too, and appending a result to one would bind the result to the
 * wrong message and break the tool_use/tool_result pairing both providers
 * require.
 */
function toolResultBatch(msg: Message | undefined): MessageContent[] | undefined {
  if (msg?.role !== 'user' || !Array.isArray(msg.content)) return undefined;
  const blocks = msg.content;
  return blocks[blocks.length - 1]?.type === 'tool_result' ? blocks : undefined;
}

/** Options for {@link toLLMMessages}. */
export interface ToLLMMessagesOptions {
  /**
   * The request goes to a provider that compacts server-side
   * (`servesServerCompaction`, providers/chained-provider.ts — the turn's
   * `TurnSetup.serverCompaction.active`). Only then is a stored compaction row
   * replayed as the in-memory envelope that provider sends back byte-exact.
   * Otherwise — the default, so every side path (the compaction summarizer,
   * the turn-end gate, a context engine) is covered without opting in — it is
   * flattened to its readable summary (`flattenCompactionEnvelopes`): a
   * provider that does not know the envelope, a plugin provider above all,
   * must never receive the nonce or `encrypted_content` as assistant text.
   */
  serverCompaction?: boolean;
}

// Reconstruct LLM-ready messages from stored history.
// Assistant messages with tool calls produce proper tool_use content blocks.
// Consecutive tool_result rows are grouped into a single user message.
export function toLLMMessages(stored: StoredMessage[], opts: ToLLMMessagesOptions = {}): Message[] {
  // History truncation invariant: `getMessages({ limit })` returns the newest
  // N rows, so the window head can slice between an assistant row carrying
  // `toolCalls` and its tool_result rows. Replaying such an orphaned
  // tool_result violates both provider contracts (Anthropic requires a
  // preceding tool_use; OpenAI Responses 400s on a function_call_output with
  // no matching function_call). Collect the surviving tool-call ids so
  // orphans can be dropped below.
  const knownToolCallIds = new Set<string>();
  for (const msg of stored) {
    if (msg.role === 'assistant' && msg.toolCalls) {
      for (const tc of msg.toolCalls) knownToolCallIds.add(tc.id);
    }
  }

  const messages: Message[] = [];

  for (const msg of stored) {
    if (msg.role === 'system') continue;

    if (msg.role === 'user') {
      // C1 — a turn whose attachments went natively to a vision-capable model
      // replays as blocks. Blocks first, then the text (which still carries the
      // <attachments> annotation), matching how the turn was originally sent.
      if (msg.contentBlocks && msg.contentBlocks.length > 0) {
        const content: MessageContent[] = [...msg.contentBlocks];
        if (msg.content) content.push({ type: 'text', text: msg.content });
        messages.push({ role: 'user', content });
      } else {
        messages.push({ role: 'user', content: msg.content });
      }
    } else if (msg.role === 'assistant') {
      // Item 7 — only a structurally-marked row replays as a compaction block;
      // a row whose TEXT merely looks like one stays text (llm.ts envelope notes).
      const compaction = compactionFromStoredRow(msg);
      if (compaction) {
        messages.push({ role: 'assistant', content: encodeCompactionEnvelope(compaction) });
      } else if (msg.toolCalls && msg.toolCalls.length > 0) {
        const content: MessageContent[] = [];
        // Blank text is never a block (see EMPTY_ASSISTANT_TEXT); tool_use follows.
        if (msg.content.trim()) content.push({ type: 'text', text: msg.content });
        for (const tc of msg.toolCalls) {
          content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input });
        }
        messages.push({ role: 'assistant', content });
      } else {
        // A stored empty model reply is kept (it carries the call's usage) but
        // never replayed blank — see EMPTY_ASSISTANT_TEXT.
        messages.push({
          role: 'assistant',
          content: msg.content.trim() ? msg.content : EMPTY_ASSISTANT_TEXT,
        });
      }
    } else if (msg.role === 'tool_result') {
      // Skip orphans whose tool_use pair was truncated off the window.
      if (!msg.toolCallId || !knownToolCallIds.has(msg.toolCallId)) continue;
      const resultBlock: MessageContent = {
        type: 'tool_result',
        tool_use_id: msg.toolCallId,
        content: msg.content,
        is_error: false,
      };
      // Append to an existing tool_result batch, or start a new one. The test
      // is "does it END in a tool_result", not "is it array-shaped": a user
      // turn carrying inline vision blocks is array-shaped too, and folding a
      // result into it would attach the result to the wrong message.
      const batch = toolResultBatch(messages[messages.length - 1]);
      if (batch) batch.push(resultBlock);
      else messages.push({ role: 'user', content: [resultBlock] });
    } else if (msg.role === 'user_steer') {
      // Steer text is already embedded as a [USER STEER]: <text> block inside
      // the tool_result user message that was constructed live during the turn.
      // The stored user_steer row exists for transcript fidelity / debugging
      // only — it must NOT be replayed as a standalone LLM message.
    }
  }

  // Mirror guard: every tool_use must have a tool_result in the immediately
  // following user message (sessions interrupted mid-turn persist the
  // assistant's toolCalls but never the results). Synthesize error results
  // for any gap so the replayed history stays pair-consistent.
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg?.role !== 'assistant' || !Array.isArray(msg.content)) continue;
    const toolUseIds = msg.content
      .filter((b): b is Extract<MessageContent, { type: 'tool_use' }> => b.type === 'tool_use')
      .map((b) => b.id);
    if (toolUseIds.length === 0) continue;

    const nextBatch = toolResultBatch(messages[i + 1]);
    const nextResults = nextBatch ?? [];
    const resultIds = new Set(
      nextResults
        .filter(
          (b): b is Extract<MessageContent, { type: 'tool_result' }> => b.type === 'tool_result',
        )
        .map((b) => b.tool_use_id),
    );
    const synthesized: MessageContent[] = toolUseIds
      .filter((id) => !resultIds.has(id))
      .map((id) => ({
        type: 'tool_result',
        tool_use_id: id,
        content: '[result unavailable — interrupted before completion]',
        is_error: true,
      }));
    if (synthesized.length === 0) continue;

    if (nextBatch) {
      nextBatch.push(...synthesized);
    } else {
      messages.splice(i + 1, 0, { role: 'user', content: synthesized });
    }
  }

  return opts.serverCompaction ? messages : flattenCompactionEnvelopes(messages);
}
