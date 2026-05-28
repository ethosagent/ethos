// drop_oldest — the safe default. Keeps the newest messages until the
// estimated token count fits the budget. The first message is preserved
// when `preserve_first_n_turns` is configured (default 0) so the original
// task description survives compaction.
import { estimateMessagesTokens } from './token-estimator';
export class DropOldestEngine {
    name = 'drop_oldest';
    async compact(opts) {
        const options = (opts.personality.context_engine_options ?? {});
        const preserveFront = Math.max(0, options.preserve_first_n_turns ?? 0);
        const target = opts.targetTokens;
        const head = opts.messages.slice(0, preserveFront);
        const tail = opts.messages.slice(preserveFront);
        let total = estimateMessagesTokens(opts.currentSystem) +
            estimateMessagesTokens(head) +
            estimateMessagesTokens(tail);
        let dropped = 0;
        while (total > target && tail.length > 0) {
            const removed = tail.shift();
            if (!removed)
                break;
            total -= estimateMessagesTokens(removed);
            dropped++;
        }
        return {
            messages: [...head, ...tail],
            notes: dropped === 0 ? 'no compaction needed' : `dropped ${dropped} oldest message(s)`,
        };
    }
}
