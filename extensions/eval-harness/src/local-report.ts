// Local-model qualification report — pure aggregation helpers used by the
// `ethos eval local` wrapper and its CI stub test. Kept in the library (not the
// CLI) so the aggregation is unit-testable without the app wiring.
//
// Category tags ride the case id as a `<category>/<name>` prefix (BatchTask has
// no category field, and parseTasksJsonl drops unknown fields). `categoryOf`
// reads that prefix back out.

/** Extract the category tag from a `<category>/<name>` case id. */
export function categoryOf(id: string): string {
  const slash = id.indexOf('/');
  return slash > 0 ? id.slice(0, slash) : 'uncategorized';
}

export interface CategoryStat {
  category: string;
  total: number;
  passed: number;
  /** passed / total, in [0,1]. */
  passRate: number;
}

/**
 * Group scored cases by their id-prefix category and compute a pass rate per
 * category. A case passes when its score is ≥ 1 (same threshold the runner uses
 * for `EvalStats.passed`). Result is sorted by category name for stable output.
 */
export function aggregateByCategory(results: Array<{ id: string; score: number }>): CategoryStat[] {
  const byCategory = new Map<string, { total: number; passed: number }>();
  for (const { id, score } of results) {
    const category = categoryOf(id);
    const stat = byCategory.get(category) ?? { total: 0, passed: 0 };
    stat.total += 1;
    if (score >= 1) stat.passed += 1;
    byCategory.set(category, stat);
  }
  return [...byCategory.entries()]
    .map(([category, { total, passed }]) => ({
      category,
      total,
      passed,
      passRate: total > 0 ? passed / total : 0,
    }))
    .sort((a, b) => a.category.localeCompare(b.category));
}

export interface RepairSummary {
  /** Malformed tool-call args mechanically recovered (`outcome: 'repaired'`). */
  repaired: number;
  /** Malformed args that could not be repaired — routed to an `is_error`
   *  tool_result, never executed (`outcome: 'failed'`). */
  failed: number;
  /** repaired + failed — every parse that needed repair at all. */
  total: number;
  /** repaired / total, in [0,1]; 1 when nothing needed repair. */
  repairSuccessRate: number;
  /**
   * Hard invariant from the plan's design decision: a malformed parse must
   * never execute a tool with `{}`. M1a routes every unrepairable parse to an
   * `is_error` tool_result, so no observability event can represent a silent
   * empty-args execution — this count is 0 by construction. Surfaced explicitly
   * so the report states the invariant rather than implying it.
   */
  executeWithEmptyArgs: number;
}

/** A `tool.repair` observability event, narrowed to the field we read. */
export interface RepairEvent {
  details?: Record<string, unknown> | null;
}

/**
 * Fold `tool.repair` observability events for a run into repair counts. The
 * `outcome` field (`'repaired' | 'failed'`) lives in `details`, written by
 * `EthosObservability.recordToolRepair`.
 */
export function summarizeRepairs(events: RepairEvent[]): RepairSummary {
  let repaired = 0;
  let failed = 0;
  for (const event of events) {
    const outcome = event.details?.outcome;
    if (outcome === 'repaired') repaired += 1;
    else if (outcome === 'failed') failed += 1;
  }
  const total = repaired + failed;
  return {
    repaired,
    failed,
    total,
    repairSuccessRate: total > 0 ? repaired / total : 1,
    executeWithEmptyArgs: 0,
  };
}

/** One scored task, as `summarizeEscalations` reads it. */
export interface EscalationRecord {
  /** `tier_escalation` events in the task (the assistant record's `escalations`). */
  escalations: number;
  score: number;
  /** The task's summed `estimated_cost_usd`. */
  costUsd: number;
}

export interface EscalationSummary {
  tasks: number;
  /** Tasks with at least one escalation. */
  escalatedTasks: number;
  /** Escalations across all tasks. */
  escalations: number;
  /** escalatedTasks / tasks; 0 with no tasks. */
  escalationRate: number;
  /** Pass rate among escalated tasks; null when none escalated. */
  passRateEscalated: number | null;
  /** Pass rate among tasks that never escalated; null when all did. */
  passRateNot: number | null;
  /** Summed cost / passed tasks; null when nothing passed. */
  costPerPassUsd: number | null;
}

/**
 * Fold scored records into the escalation report: how often the model asked
 * for `deep`, how those tasks fared against the rest, and what a passing task
 * cost. Compare two runs (as is, and `--tier deep`) by diffing this block.
 * A task passes at score >= 1, the runner's own threshold.
 */
export function summarizeEscalations(records: EscalationRecord[]): EscalationSummary {
  let escalatedTasks = 0;
  let escalations = 0;
  let escalatedPassed = 0;
  let plainTasks = 0;
  let plainPassed = 0;
  let passed = 0;
  let costUsd = 0;
  for (const r of records) {
    const pass = r.score >= 1;
    costUsd += r.costUsd;
    if (pass) passed += 1;
    escalations += r.escalations;
    if (r.escalations > 0) {
      escalatedTasks += 1;
      if (pass) escalatedPassed += 1;
    } else {
      plainTasks += 1;
      if (pass) plainPassed += 1;
    }
  }
  return {
    tasks: records.length,
    escalatedTasks,
    escalations,
    escalationRate: records.length > 0 ? escalatedTasks / records.length : 0,
    passRateEscalated: escalatedTasks > 0 ? escalatedPassed / escalatedTasks : null,
    passRateNot: plainTasks > 0 ? plainPassed / plainTasks : null,
    costPerPassUsd: passed > 0 ? costUsd / passed : null,
  };
}
