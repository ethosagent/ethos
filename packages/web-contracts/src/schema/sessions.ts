import { z } from 'zod';

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export const SessionUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  cacheCreationTokens: z.number().int().nonnegative(),
  estimatedCostUsd: z.number().nonnegative(),
  apiCallCount: z.number().int().nonnegative(),
  compactionCount: z.number().int().nonnegative(),
});
export type SessionUsage = z.infer<typeof SessionUsageSchema>;

export const SessionSchema = z.object({
  id: z.string(),
  key: z.string(),
  platform: z.string(),
  model: z.string(),
  provider: z.string(),
  personalityId: z.string().nullable(),
  parentSessionId: z.string().nullable(),
  workingDir: z.string().nullable(),
  title: z.string().nullable(),
  pinned: z.boolean(),
  usage: SessionUsageSchema,
  createdAt: z.string(), // ISO-8601
  updatedAt: z.string(), // ISO-8601
  /** Optimistic-concurrency version. v1 always returns 1. */
  version: z.number().int(),
});
export type Session = z.infer<typeof SessionSchema>;

export const MessageRoleSchema = z.enum([
  'user',
  'assistant',
  'tool_result',
  'system',
  'user_steer',
]);
export type MessageRole = z.infer<typeof MessageRoleSchema>;

export const ToolCallSchema = z.object({
  id: z.string(),
  name: z.string(),
  input: z.unknown(),
});
export type ToolCall = z.infer<typeof ToolCallSchema>;

export const StoredMessageSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  role: MessageRoleSchema,
  content: z.string(),
  toolCallId: z.string().nullable(),
  toolName: z.string().nullable(),
  toolCalls: z.array(ToolCallSchema).nullable(),
  /**
   * Did this `tool_result` row record a failure? Optional, not nullable:
   * ABSENT means the outcome was never recorded (a row written before the
   * flag existed), which is not the same as `false`. Surfaces must not read
   * absent as success.
   */
  isError: z.boolean().optional(),
  /**
   * The turn's observability trace id, when the turn was traced. Optional:
   * absent on untraced turns and on rows written before `trace_id` existed.
   * It is the anchor a persisted router decision row (`SessionDecision`,
   * events.ts) is placed by on reload (plan decision-provider-personality §15.5).
   */
  traceId: z.string().optional(),
  timestamp: z.string(), // ISO-8601
});
export type StoredMessage = z.infer<typeof StoredMessageSchema>;
