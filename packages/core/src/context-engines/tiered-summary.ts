// tiered_summary — three-tier compaction: preserve front, summarize + page
// the middle, keep the recent tail. Combines LLM summarization with external
// store paging so a compressed summary stays in-window while the full middle
// is recoverable from storage. Degrades gracefully when either handle is
// missing.

import type {
  ContextEngine,
  ContextEngineCompactInput,
  ContextEngineCompactOutput,
  ContextEngineExternalWrite,
  ContextEngineRemovedEntry,
  Message,
  MessageContent,
} from '@ethosagent/types';
import { estimateMessagesTokens, estimateMessageTokens } from './token-estimator';

interface TieredSummaryOptions {
  preserve_first_n_turns?: number;
  recent_window?: number;
  page_key_prefix?: string;
}

export class TieredSummaryEngine implements ContextEngine {
  readonly name = 'tiered_summary';

  async compact(opts: ContextEngineCompactInput): Promise<ContextEngineCompactOutput> {
    const options = (opts.personality.context_engine_options ?? {}) as TieredSummaryOptions;
    const preserveFront = Math.max(0, options.preserve_first_n_turns ?? 1);
    const recentWindow = Math.max(0, options.recent_window ?? 6);
    const prefix = options.page_key_prefix ?? 'paged';
    const target = opts.targetTokens;

    const front = opts.messages.slice(0, preserveFront);
    const tailKeep = Math.min(recentWindow, Math.max(0, opts.messages.length - preserveFront));
    const middle = opts.messages.slice(preserveFront, opts.messages.length - tailKeep);
    const tail = opts.messages.slice(opts.messages.length - tailKeep);

    if (middle.length === 0) {
      return { messages: opts.messages, notes: 'nothing to summarize' };
    }

    const ct = opts.countTokens;
    const measure = ct
      ? (msgs: Message[]) => ct(msgs)
      : (msgs: Message[]) => Promise.resolve(estimateMessagesTokens(msgs));

    const totalNow =
      estimateMessagesTokens(opts.currentSystem) + (await measure([...front, ...middle, ...tail]));
    if (totalNow <= target) {
      return { messages: opts.messages, notes: 'no compaction needed' };
    }

    // --- Summarize middle ---
    const summaryTarget = Math.max(200, Math.floor(target * 0.15));
    let summaryText: string;
    if (opts.llm) {
      summaryText = await opts.llm.summarize(middle, summaryTarget);
    } else {
      summaryText = `[summary] ${middle.length} earlier message(s) elided to fit context budget.`;
    }

    // --- Page middle to store ---
    const externalWrites: ContextEngineExternalWrite[] = [];
    if (opts.store) {
      const key = `${prefix}-${opts.sessionMetadata.turnNumber}`;
      const serialized = JSON.stringify(middle);
      await opts.store.write(key, serialized);
      externalWrites.push({ key, tokenCount: estimateMessagesTokens(middle) });
    }

    // --- Build removed entries ---
    const reason: ContextEngineRemovedEntry['reason'] = opts.llm
      ? 'summarized'
      : opts.store
        ? 'paged_out'
        : 'trimmed';
    const removed: ContextEngineRemovedEntry[] = middle.map((_, i) => ({
      index: preserveFront + i,
      reason,
    }));

    const summaryMessage: Message = {
      role: 'assistant',
      content: [{ type: 'text', text: summaryText } satisfies MessageContent],
    };

    // Cache breakpoints: end of front, the summary message.
    const cacheBreakpoints: number[] = [];
    if (front.length > 0) cacheBreakpoints.push(front.length - 1);
    cacheBreakpoints.push(front.length);

    return {
      messages: [...front, summaryMessage, ...tail],
      notes: `summarized ${middle.length} message(s) → ${estimateMessageTokens(summaryMessage)} tokens`,
      summaryText,
      cacheBreakpoints,
      removed,
      summaries: [
        { text: summaryText, sourceRange: [preserveFront, preserveFront + middle.length] },
      ],
      externalWrites: externalWrites.length > 0 ? externalWrites : undefined,
      cacheAnchor: front.length,
    };
  }

  shouldCompact(input: ContextEngineCompactInput): boolean {
    const total =
      estimateMessagesTokens(input.currentSystem) + estimateMessagesTokens(input.messages);
    return total > input.targetTokens * 0.75;
  }
}
