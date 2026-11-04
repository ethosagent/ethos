import type { ModifyingHooks, VoidHooks } from '@ethosagent/types';

/**
 * Exhaustive name tables. Typed as full records so a hook added to
 * `VoidHooks` / `ModifyingHooks` fails typecheck here until it is listed, which
 * keeps the host's accepted names in step with the frozen hook models.
 */
const VOID: Record<keyof VoidHooks, true> = {
  session_start: true,
  before_llm_call: true,
  after_llm_call: true,
  after_tool_call: true,
  tool_end_with_path: true,
  agent_done: true,
  message_received: true,
  message_sent: true,
  subagent_spawned: true,
  subagent_ended: true,
  after_ticket_revision: true,
  process_complete: true,
  on_background_job_complete: true,
  goal_completed: true,
  goal_failed: true,
  goal_exhausted: true,
  goal_needs_clarification: true,
  ticket_claimed: true,
  ticket_blocked: true,
  ticket_completed: true,
  ticket_stale_reclaimed: true,
  ticket_updated: true,
  dispatch_tick: true,
};

const MODIFYING: Record<keyof ModifyingHooks, true> = {
  before_prompt_build: true,
  before_tool_call: true,
  message_sending: true,
  personality_switched: true,
  subagent_spawning: true,
};

export function isVoidHook(name: string): name is keyof VoidHooks {
  return Object.hasOwn(VOID, name);
}

export function isModifyingHook(name: string): name is keyof ModifyingHooks {
  return Object.hasOwn(MODIFYING, name);
}
