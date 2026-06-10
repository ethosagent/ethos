export interface ClassificationResult {
  isGoal: boolean;
  confidence: number;
  restatedGoal?: string;
}

/**
 * Cheap heuristic prefilter: imperative phrasing, multi-step ask, deadline words.
 * Returns true if the message is likely a goal (gates the classifier call).
 */
export function prefilterGoal(message: string): boolean {
  const imperativePatterns = [
    /^(analyze|build|create|deploy|fetch|find|generate|implement|investigate|monitor|prepare|research|run|scan|set up|track|write)\b/i,
    /\b(and then|after that|once done|finally|step \d)\b/i,
    /\b(daily|weekly|every|schedule|recurring|automat)\b/i,
    /\b(by|before|deadline|until|within)\s+(tomorrow|next|end of|monday|tuesday|wednesday|thursday|friday)\b/i,
  ];
  return imperativePatterns.some((p) => p.test(message));
}

/**
 * Classify whether a message is a goal or just chat.
 * In production, this calls a cheap/fast model. For now, returns the prefilter result.
 */
export async function classifyGoal(message: string): Promise<ClassificationResult> {
  const likely = prefilterGoal(message);
  return {
    isGoal: likely,
    confidence: likely ? 0.7 : 0.2,
    restatedGoal: likely ? message : undefined,
  };
}
