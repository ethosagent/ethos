export function checkTurnBudgets(
  totalToolCalls: number,
  maxToolCallsPerTurn: number,
  toolNameCounts: Map<string, number>,
  maxIdenticalToolCalls: number,
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
  return { exceeded: false };
}
