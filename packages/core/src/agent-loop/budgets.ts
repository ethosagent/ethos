/** Running streak of consecutive tool calls with identical name + args. */
export interface IdenticalStreak {
  /** Identity key — `${toolName}:${JSON.stringify(args)}`. */
  key: string;
  toolName: string;
  count: number;
}

/**
 * Fold one completed tool call into the consecutive-identical-call streak.
 * Same key as the previous call extends the streak; any different call
 * (different name OR different args) resets it to 1.
 */
export function updateIdenticalStreak(
  prev: IdenticalStreak | null,
  toolName: string,
  args: unknown,
): IdenticalStreak {
  let key: string;
  try {
    key = `${toolName}:${JSON.stringify(args)}`;
  } catch {
    // Non-serializable args (shouldn't happen for JSON tool args) — fall back
    // to the tool name so the guard still functions, just more coarsely.
    key = toolName;
  }
  if (prev && prev.key === key) {
    return { key, toolName, count: prev.count + 1 };
  }
  return { key, toolName, count: 1 };
}

export function checkTurnBudgets(
  totalToolCalls: number,
  maxToolCallsPerTurn: number,
  toolNameCounts: Map<string, number>,
  maxIdenticalToolCalls: number,
  identicalStreak: IdenticalStreak | null,
  maxConsecutiveIdenticalCalls: number,
): { exceeded: false } | { exceeded: true; toolName: string; message: string } {
  if (totalToolCalls >= maxToolCallsPerTurn) {
    return {
      exceeded: true,
      toolName: '_budget',
      message: `Stopped: hit ${maxToolCallsPerTurn}-tool-call budget for this turn`,
    };
  }
  const overused = [...toolNameCounts.entries()].find(
    ([, count]) => count >= maxIdenticalToolCalls,
  );
  if (overused) {
    return {
      exceeded: true,
      toolName: overused[0],
      message: `Stopped: ${overused[0]} called ${overused[1]} times in one turn (likely loop)`,
    };
  }
  if (identicalStreak && identicalStreak.count >= maxConsecutiveIdenticalCalls) {
    return {
      exceeded: true,
      toolName: identicalStreak.toolName,
      message: `Stopped: ${identicalStreak.toolName} called ${identicalStreak.count} times in a row with identical arguments (loop)`,
    };
  }
  return { exceeded: false };
}
