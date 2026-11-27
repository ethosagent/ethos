/**
 * L1 of the initiative read-only enforcement map: the four tool classes.
 * Every tool name belongs to exactly one class (pinned by
 * `initiative-allowlist.test.ts`; the census over the composed registry is
 * `packages/wiring/src/__tests__/initiative-readonly-census.test.ts`).
 */

/** Fixed in code. Config can only remove entries (via the personality toolset intersection). */
export const INITIATIVE_READ_TOOLS = Object.freeze([
  'web_search',
  'web_extract',
  'engine_ask',
  'linkedin_search',
  'reddit_web_search',
  'quora_search',
  'youtube_search',
  'youtube_comments',
  'reddit_search',
  'reddit_thread',
  'x_search',
  'session_search',
  'session_list_by_date',
  'memory_read',
  'team_memory_read',
  'team_memory_search',
  'kanban_list',
  'kanban_show',
  'goal_status',
  'read_file',
  'search_files',
] as const);

/** Engine tools: always available to a run, regardless of the personality toolset. */
export const INITIATIVE_LEDGER_TOOLS = Object.freeze([
  'initiative_propose',
  'initiative_note',
  'initiative_brief',
  'initiative_ideas',
  'initiative_budget',
  'initiative_list',
  'initiative_search',
  'initiative_get',
  'clarify',
] as const);

/** Chat-only tools (owner conversation); never part of a run. */
export const INITIATIVE_CHAT_TOOLS = Object.freeze([
  'initiative_define',
  'initiative_add_ideas',
] as const);

/** A Set that throws on mutation. `Object.freeze` does not stop `Set.prototype.add`. */
class FrozenSet<T> extends Set<T> {
  #sealed = false;
  constructor(values: readonly T[]) {
    super();
    for (const v of values) super.add(v);
    this.#sealed = true;
    Object.freeze(this);
  }
  override add(value: T): this {
    if (this.#sealed) throw new TypeError('INITIATIVE_NEVER_TOOLS is frozen');
    return super.add(value);
  }
  override delete(_value: T): boolean {
    throw new TypeError('INITIATIVE_NEVER_TOOLS is frozen');
  }
  override clear(): void {
    throw new TypeError('INITIATIVE_NEVER_TOOLS is frozen');
  }
}

/**
 * Named so the census can tell a deliberate refusal from an oversight.
 * Best-effort at Task 2.1: Task 2.7 reconciles it against the composed registry
 * (including `NOT_COMPOSED` entries for names no profile registers).
 */
export const INITIATIVE_NEVER_TOOLS: ReadonlySet<string> = new FrozenSet<string>([
  // writes and creates
  'write_file',
  'patch_file',
  'memory_write',
  'team_memory_write',
  'goal_create',
  'goal_complete',
  'todo_add',
  'todo_clear',
  'todo_list',
  'todo_set',
  'todo_update',
  'kanban_archive',
  'kanban_assign',
  'kanban_block',
  'kanban_comment',
  'kanban_complete',
  'kanban_create',
  'kanban_create_goal',
  'kanban_create_swarm',
  'kanban_decompose',
  'kanban_heartbeat',
  'kanban_link',
  'kanban_unblock',
  'kanban_update_status',
  'dashboard_save',
  'dashboard_create',
  'dashboard_add_panel',
  'dashboard_update_panel',
  'dashboard_update_panel_layout',
  'dashboard_set_params',
  'dashboard_import',
  'dashboard_export',
  'dashboard_list_panels',
  'image_generate',
  // outbound messaging and scheduling
  'send_message',
  'cron',
  'watcher_create',
  'watcher_list',
  'call',
  'voice_session',
  'agent_consult',
  'meet_join',
  // delegation and a2a
  'delegate_task',
  'dispatch_team',
  'broadcast_to_agents',
  'route_to_agent',
  'mixture_of_agents',
  'list_team',
  'task_cancel',
  'task_logs',
  'task_result',
  'task_status',
  'task_steer',
  'a2a_send',
  // skills
  'get_skill',
  'skill_view',
  'skill_propose',
  'skill_read',
  'skills_list',
  'skills_pending_approve',
  'skills_pending_list',
  'skills_pending_reject',
  'skills_pending_view',
  // personality design
  'list_available_models',
  'list_available_skills',
  'list_available_tools',
  'list_personalities',
  'list_team_patterns',
  'scaffold_personality',
  'scaffold_team',
  'propose_self_amendment',
  // browser
  'browse_url',
  'browser_back',
  'browser_click',
  'browser_computed_style',
  'browser_console',
  'browser_dialog',
  'browser_fill_credential',
  'browser_get_images',
  'browser_navigate',
  'browser_press',
  'browser_request_takeover',
  'browser_screenshot',
  'browser_scroll',
  'browser_type',
  'browser_vision_click',
  'browser_vision_type',
  // code, terminal, process
  'run_code',
  'run_tests',
  'lint',
  'terminal',
  'process_list',
  'process_logs',
  'process_start',
  'process_stop',
  'process_wait',
  'process_watch',
  // rendering and cards
  'render_file',
  'render_html',
  'render_image',
  'render_ui',
  'emit_card',
  // decisions, debug, search console, vision, tiering
  'decide',
  'get_error_log',
  'get_observability',
  'get_session_events',
  'run_doctor',
  'gsc_queries',
  'gsc_sites',
  'video_analyze',
  'vision_analyze',
  'think_deeper',
]);

/**
 * Tool names an initiative run may call: READ ∩ personality toolset, then every
 * LEDGER tool (engine tools, not personality-configurable).
 *
 * Toolset semantics mirror `DefaultToolRegistry.toolNamesForPersonality`
 * (packages/core/src/tool-registry.ts): `undefined` is unrestricted, so the whole
 * read allowlist; `[]` allows nothing (only ledger tools remain); there is no
 * wildcard, so `'*'` matches no tool name. A toolset can only remove READ
 * entries, never add one.
 */
export function runToolNames(personalityToolset: readonly string[] | undefined): string[] {
  const read = personalityToolset
    ? INITIATIVE_READ_TOOLS.filter((n) => personalityToolset.includes(n))
    : [...INITIATIVE_READ_TOOLS];
  return [...read, ...INITIATIVE_LEDGER_TOOLS];
}
