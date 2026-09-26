import type { PersonalityConfig, ToolRegistry } from '@ethosagent/types';

// ---------------------------------------------------------------------------
// SCRIPT_SAFE — the static exclusion policy for the script-callable tool
// surface (tools-as-code-api plan, Lane C). A script running inside a
// `run_code` sandbox may call `scriptCallable = personality.toolset ∩
// SCRIPT_SAFE` — a pure derivation, never a PersonalityConfig field. The
// ScriptToolBridge (Lane B) and the character sheet (Lane G) both consume
// `scriptCallableFor`, so the displayed surface cannot drift from the
// enforced one.
//
// The policy works off metadata available at the core layer only: the
// tool's `toolset` group, the registry's pluginId tag, and naming
// conventions (`mcp__*`, `clarify`). It never imports extension packages.
// ---------------------------------------------------------------------------

/** Why a tool is excluded from the script-callable surface. */
export type ScriptExclusionCategory =
  | 'code'
  | 'delegation'
  | 'mcp'
  | 'plugin'
  | 'clarify'
  | 'credentials'
  | 'decision';

const EXCLUSION_REASONS: Record<ScriptExclusionCategory, string> = {
  code: 'code-execution tools are not script-callable — recursion guard (a script cannot start a script)',
  delegation:
    'delegation tools are not script-callable — a script has no identity in the spawn-depth ledger',
  mcp: 'MCP tools are not script-callable at v1',
  plugin: 'plugin tools are not script-callable at v1',
  clarify: 'clarify is not script-callable — a script waiting on a human is a hung container',
  credentials:
    'credential-returning tools are not script-callable — their results can carry secret ' +
    'material (host environment via terminal, raw session transcripts via debug tools), ' +
    'which must not reach untrusted sandboxed code',
  decision:
    'decision tools are not script-callable — their visibility is decided per personality, ' +
    'which this advertised list does not read, and a script looping over the decision model ' +
    'is batch work the plugin helper owns',
};

/** Tool metadata the policy inspects — all of it available at the core layer. */
export interface ScriptSafeToolMeta {
  /** The tool's `toolset` group (e.g. 'code', 'delegation', 'file'). */
  toolset?: string;
  /** The plugin that registered the tool, per `ToolRegistry.getPluginId`. */
  pluginId?: string;
}

/**
 * The static exclusion policy. Returns the exclusion category for a tool
 * that must NOT be callable from a script, or `null` when the tool is
 * script-safe (subject to the personality allowlist, enforced elsewhere).
 */
export function scriptExclusionFor(
  toolName: string,
  meta: ScriptSafeToolMeta = {},
): ScriptExclusionCategory | null {
  if (toolName.startsWith('mcp__')) return 'mcp';
  if (meta.pluginId !== undefined) return 'plugin';
  // Recursion guard: run_code, run_tests, lint — exec-posture tools whose
  // container/host routing assumes a top-level call.
  if (meta.toolset === 'code') return 'code';
  // delegate_task, mixture_of_agents, route_to_agent, dispatch_team,
  // broadcast_to_agents, task_* (and list_team, which rides along) all
  // declare `toolset: 'delegation'` — spawning has no depth ledger for a
  // script caller.
  if (meta.toolset === 'delegation') return 'delegation';
  // Lane F verify-first #5 (2026-08 audit): `terminal`'s host-exec path
  // inherits the full host environment (scoped-process defaults to
  // process.env), so its result can echo provider keys; `debug` tools
  // (get_session_events / get_observability) replay raw, unredacted
  // transcript content from ANY stored session. Both would hand credential
  // material to an untrusted script — excluded as a category.
  if (meta.toolset === 'terminal' || meta.toolset === 'debug') return 'credentials';
  // plan decision-tool D14 — `decide` is `alwaysInclude`, so the allowlist
  // above would advertise it even to a personality whose per-personality
  // exclusion hides it (this derivation does not read `excludeTools`).
  if (meta.toolset === 'decision') return 'decision';
  // Blocks the turn on an interactive surface mid-script.
  if (toolName === 'clarify') return 'clarify';
  return null;
}

/**
 * The script-side error for a call to an excluded tool. Names the exclusion
 * category so a script author can tell policy apart from a generic failure.
 */
export function scriptExclusionError(toolName: string, category: ScriptExclusionCategory): string {
  return `Tool ${toolName} is not script-callable (excluded category: ${category}). ${EXCLUSION_REASONS[category]}`;
}

/**
 * Pure derivation of the script-callable surface for a personality:
 * `personality.toolset ∩ SCRIPT_SAFE`, gated on the personality DECLARING
 * `run_code` — one that never asked for a script surface has none. Returns
 * sorted tool names.
 *
 * The allowlist rule mirrors `toDefinitions`/`executeParallel`: the toolset
 * gates built-in tools by exact name; MCP and plugin tools bypass the name
 * allowlist but are excluded by the policy above anyway.
 *
 * The gate is DELIBERATELY not `run_code` being AVAILABLE.
 * `run_code.isAvailable()` (`extensions/tools-code/src/index.ts`) returns the
 * `backendWired` flag it was constructed with, set once at composition from
 * whether an execution backend was built for the DEPLOYMENT DEFAULT
 * personality (`composeAllTools` in `packages/wiring/src/compose-tools.ts`,
 * `backendWired: executionBackend !== undefined`). Gating on it emptied the
 * surface for every personality in a chat-only-default process — including one
 * that declares `run_code` and resolves an execution posture of its own
 * (execution IS routed per turn, `createExecutionRouting.resolveTurn`), and
 * including consumers that never enter a container at all: an in-process
 * plugin reaching `ToolContext.scriptTools`.
 *
 * Widening the gate does not widen the surface. The names are still
 * `registry.getAvailable()` ∩ toolset − `scriptExclusionFor`, so a tool whose
 * own `isAvailable()` is false stays absent and the result stays a subset of
 * what the agent itself may call this turn.
 *
 * Two edge cases, both deliberate. A personality with NO `toolset` is
 * unrestricted — the same reading of `allowed` the filter below and
 * `toDefinitions` use, and the shape `ScriptToolBridge` passes for an
 * unrestricted turn — so it gets a surface. And `run_code` missing from the
 * registry entirely does not empty the surface either: the gate asks what the
 * personality declared, not what the process composed. Both are pinned in
 * `packages/core/src/__tests__/script-safe.test.ts`.
 */
export function scriptCallableFor(
  personality: Pick<PersonalityConfig, 'toolset'>,
  registry: Pick<ToolRegistry, 'getAvailable' | 'getPluginId'>,
): string[] {
  const allowed = personality.toolset;
  if (allowed && !allowed.includes('run_code')) return [];
  const permitted = registry.getAvailable().filter((tool) => {
    const isMcpOrPluginTool =
      tool.name.startsWith('mcp__') || registry.getPluginId?.(tool.name) !== undefined;
    if (!isMcpOrPluginTool && !tool.alwaysInclude && allowed && !allowed.includes(tool.name)) {
      return false;
    }
    return true;
  });
  return permitted
    .filter(
      (tool) =>
        scriptExclusionFor(tool.name, {
          toolset: tool.toolset,
          pluginId: registry.getPluginId?.(tool.name),
        }) === null,
    )
    .map((tool) => tool.name)
    .sort();
}
