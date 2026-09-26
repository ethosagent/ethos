// One owner for the next typed line of a readline session. Every prompt that
// reads a single line in `ethos chat` — the tool-approval prompt
// (`attachCliApprovalPrompt`), the clarify presenter, the quick-command consent
// question and the masked credential read — claims the line here instead of
// calling `rl.once('line')` itself. Before this, two open prompts each had a
// `once` listener, so one typed line answered both: a `y` meant for an approval
// also answered a clarify, and a clarify answer silently denied the approval.
//
// One claim owns the line at a time; the rest wait FIFO. A claim's `show` runs
// only when it becomes the owner, so the user only ever sees the question the
// next line will answer. The owner gets exactly one line, then the next claim
// is shown. Pinned by `src/__tests__/line-arbiter.test.ts`.

/** The slice of `readline.Interface` the arbiter drives. */
export interface LineSource {
  once(event: 'line', listener: (line: string) => void): unknown;
  off(event: 'line', listener: (line: string) => void): unknown;
}

export interface LinePrompt {
  /** Draw the question. Called once, when this claim becomes the owner. */
  show: () => void;
  /** The one line typed while this claim owned the input. */
  onLine: (line: string) => void;
}

export interface LineClaim {
  /**
   * Give up the claim without a line — the request was settled another way
   * (timeout, cancel). An owner hands the line to the next claim; a waiting
   * claim leaves the queue unshown. A no-op once the line was delivered.
   */
  release: () => void;
}

export interface LineArbiter {
  claim: (prompt: LinePrompt) => LineClaim;
  /**
   * True while a claim owns the line or waits for it. A prompt that closes
   * checks this before redrawing the chat prompt, so it does not overwrite the
   * question of the prompt that now owns the line.
   */
  busy: () => boolean;
}

export function createLineArbiter(rl: LineSource): LineArbiter {
  interface Entry extends LinePrompt {
    listener?: (line: string) => void;
  }
  const queue: Entry[] = [];
  let owner: Entry | null = null;

  const advance = (): void => {
    if (owner) return;
    const next = queue.shift();
    if (!next) return;
    owner = next;
    const listener = (line: string): void => {
      if (owner !== next) return;
      owner = null;
      try {
        next.onLine(line);
      } finally {
        // Shown only after the answer's own output, so the next question is
        // drawn below it rather than above.
        advance();
      }
    };
    next.listener = listener;
    rl.once('line', listener);
    next.show();
  };

  return {
    claim: (prompt) => {
      const entry: Entry = { ...prompt };
      queue.push(entry);
      advance();
      return {
        release: () => {
          if (owner === entry) {
            if (entry.listener) rl.off('line', entry.listener);
            owner = null;
            advance();
            return;
          }
          const index = queue.indexOf(entry);
          if (index >= 0) queue.splice(index, 1);
        },
      };
    },
    busy: () => owner !== null || queue.length > 0,
  };
}
