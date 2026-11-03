import { z } from 'zod';

// ---------------------------------------------------------------------------
// Tool approval (used by SSE push + tools.approve/deny RPCs)
// ---------------------------------------------------------------------------

export const ApprovalScopeSchema = z.enum([
  'once', // Allow this single invocation
  'exact-args', // Allow this tool with these exact arguments
  'any-args', // Allow this tool with any arguments
  'lease-1h', // Allow this tool, any args, in this session + personality, for one hour
]);
export type ApprovalScope = z.infer<typeof ApprovalScopeSchema>;

export const ApprovalRequestSchema = z.object({
  approvalId: z.string(),
  sessionId: z.string(),
  toolCallId: z.string(),
  toolName: z.string(),
  args: z.unknown(),
  reason: z.string().nullable(),
  /** True when the tool is always-ask and so cannot be allowlisted
   *  (`exact-args`/`any-args` are refused server-side by
   *  `ApprovalsService.approve`); the modal offers `lease-1h` instead. */
  alwaysAsk: z.boolean(),
  /** True for a hardline command: `ApprovalsService.approve` stores nothing
   *  for it whatever the scope (no allowlist entry, no lease), so the modal
   *  offers only "just this command". */
  hardline: z.boolean(),
});
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;

/** Mirrors `ApprovalLease` in `@ethosagent/types` — a time-limited grant. */
export const ApprovalLeaseSchema = z.object({
  id: z.string(),
  toolName: z.string(),
  sessionId: z.string(),
  personalityId: z.string().nullable(),
  grantedBy: z.string(),
  grantedAt: z.string(),
  expiresAt: z.string(),
  revokedAt: z.string().nullable(),
});
export type ApprovalLeaseWire = z.infer<typeof ApprovalLeaseSchema>;
