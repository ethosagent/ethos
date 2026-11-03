import { z } from 'zod';

// ---------------------------------------------------------------------------
// Mesh — swarm pillar of v0.5
//
// Surfaces the agent-mesh extension state. Each peer reports its
// capabilities + current load; the route-test endpoint asks the mesh to
// route a synthetic task so the user can verify discovery + delivery
// without sending real work.
// ---------------------------------------------------------------------------

export const MeshAgentSchema = z.object({
  agentId: z.string(),
  /** Capability tokens declared by the peer (e.g. `code`, `web`, `delegate`). */
  capabilities: z.array(z.string()),
  /** Open sessions the peer is currently handling. */
  activeSessions: z.number().int().nonnegative(),
  /** Last heartbeat from this peer (ISO-8601). */
  lastSeenAt: z.string(),
});
export type MeshAgent = z.infer<typeof MeshAgentSchema>;

// ---------------------------------------------------------------------------
// Lab — Batch + Eval (v1)
//
// Both surfaces wrap long-running runners (BatchRunner, EvalRunner)
// from their respective extensions. The wire shape is "submit
// + poll" — start returns a run id, list/get return live state, the
// runner streams progress through `onProgress` callbacks the service
// caches into the run state. Cancel is deferred — the existing
// checkpoint mechanism makes re-runs idempotent.
// ---------------------------------------------------------------------------

export const BatchRunStatusSchema = z.enum(['pending', 'running', 'completed', 'failed']);
export type BatchRunStatus = z.infer<typeof BatchRunStatusSchema>;

export const BatchRunInfoSchema = z.object({
  id: z.string(),
  status: BatchRunStatusSchema,
  total: z.number().int().nonnegative(),
  completed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  outputPath: z.string(),
  errorMessage: z.string().nullable(),
});
export type BatchRunInfo = z.infer<typeof BatchRunInfoSchema>;

export const EvalScorerSchema = z.enum(['exact', 'contains', 'regex', 'llm']);
export type EvalScorer = z.infer<typeof EvalScorerSchema>;

export const EvalRunInfoSchema = z.object({
  id: z.string(),
  status: BatchRunStatusSchema,
  scorer: EvalScorerSchema,
  total: z.number().int().nonnegative(),
  passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  /** 0-1 average score across all tasks. */
  avgScore: z.number().min(0).max(1),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  outputPath: z.string(),
  errorMessage: z.string().nullable(),
});
export type EvalRunInfo = z.infer<typeof EvalRunInfoSchema>;
