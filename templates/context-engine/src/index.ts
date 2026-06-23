// Template: Custom Context Engine
//
// Copy this template into your workspace, rename the class, and implement
// your compaction strategy. Register the engine via your plugin's setup():
//
//   api.registerContextEngine(new MyEngine());
//
// Then select it in a personality config:
//
//   context_engine: my_engine_name

import type {
  ContextEngine,
  ContextEngineCompactInput,
  ContextEngineCompactOutput,
  ContextEngineExternalWrite,
  ContextEngineRemovedEntry,
  Message,
  MessageContent,
} from '@ethosagent/types';

// ---------------------------------------------------------------------------
// Cheap token estimator — same heuristic as the framework's token-estimator.ts.
// Use opts.countTokens() when available for model-accurate counts.
// ---------------------------------------------------------------------------
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function estimateMessageTokens(msg: Message): number {
  if (typeof msg.content === 'string') return estimateTokens(msg.content);
  let chars = 0;
  for (const block of msg.content) {
    if (block.type === 'text') chars += block.text.length;
  }
  return Math.ceil(chars / 4);
}

function estimateAllTokens(messages: Message[], system: string): number {
  let total = estimateTokens(system);
  for (const m of messages) total += estimateMessageTokens(m);
  return total;
}

// ---------------------------------------------------------------------------
// Engine implementation
// ---------------------------------------------------------------------------

export class CustomContextEngine implements ContextEngine {
  // Replace with your engine's unique name. This is the string authors put
  // in personality config: `context_engine: custom_engine`
  readonly name = 'custom_engine';

  // --- shouldCompact (optional) -------------------------------------------
  // The framework calls this before its default 80% pressure gate.
  // Return true to trigger compaction earlier (never later — the framework's
  // gate is the floor).
  shouldCompact(input: ContextEngineCompactInput): boolean {
    const current = estimateAllTokens(input.messages, input.currentSystem);
    // Trigger at 75% of target — leaves headroom for the next turn.
    return current > input.targetTokens * 0.75;
  }

  // --- compact ------------------------------------------------------------
  // Called when the framework decides compaction is needed. Must return a
  // valid message history that fits (or is closer to fitting) the budget.
  async compact(opts: ContextEngineCompactInput): Promise<ContextEngineCompactOutput> {
    const { messages, currentSystem, targetTokens } = opts;

    // 1. Check whether compaction is actually needed.
    const currentTokens = estimateAllTokens(messages, currentSystem);
    if (currentTokens <= targetTokens) {
      return { messages, notes: 'no compaction needed' };
    }

    // 2. Split the history into three regions:
    //    - front: the first message (task description) — always preserved
    //    - middle: candidates for summarization / eviction
    //    - tail: the last 4 messages — recent context the LLM needs verbatim
    const front = messages.slice(0, 1);
    const tailSize = Math.min(4, Math.max(0, messages.length - 1));
    const middle = messages.slice(1, messages.length - tailSize);
    const tail = messages.slice(messages.length - tailSize);

    // Nothing in the middle to compact — return unchanged.
    if (middle.length === 0) {
      return { messages, notes: 'no compaction needed — no middle segment' };
    }

    // 3. Summarize the middle segment.
    //    Use the injected LLM handle when available; fall back to a placeholder.
    let summaryText: string;
    if (opts.llm) {
      const summaryTarget = Math.max(200, Math.floor(targetTokens * 0.15));
      summaryText = await opts.llm.summarize(middle, summaryTarget);
    } else {
      summaryText = `[summary] ${middle.length} earlier message(s) were removed to fit the context budget.`;
    }

    // 4. Page out the raw middle to the external store when available.
    //    This preserves full fidelity for later retrieval if the engine or
    //    personality supports recall.
    const externalWrites: ContextEngineExternalWrite[] = [];
    if (opts.store) {
      const serialized = JSON.stringify(middle);
      const key = `compacted-${opts.sessionMetadata.sessionId}-${Date.now()}`;
      await opts.store.write(key, serialized);
      externalWrites.push({ key, tokenCount: estimateTokens(serialized) });
    }

    // 5. Build the synthetic summary message.
    const summaryContent: MessageContent = { type: 'text', text: summaryText };
    const summaryMessage: Message = {
      role: 'assistant',
      content: [summaryContent],
    };

    // 6. Assemble the compacted history.
    const compacted = [...front, summaryMessage, ...tail];

    // 7. Build the audit trail.
    const removed: ContextEngineRemovedEntry[] = middle.map((_, i) => ({
      index: i + 1, // offset by front.length (1)
      reason: opts.store ? ('paged_out' as const) : ('summarized' as const),
    }));

    // 8. Cache breakpoints: end of preserved-front and the summary message.
    const cacheBreakpoints: number[] = [];
    if (front.length > 0) cacheBreakpoints.push(front.length - 1);
    cacheBreakpoints.push(front.length); // the summary message index

    return {
      messages: compacted,
      notes: `summarized ${middle.length} message(s) into 1`,
      summaryText,
      removed,
      summaries: [{ text: summaryText, sourceRange: [1, 1 + middle.length] }],
      externalWrites: externalWrites.length > 0 ? externalWrites : undefined,
      cacheBreakpoints,
    };
  }
}

// Default export for convenience; named export for explicit imports.
export default CustomContextEngine;
