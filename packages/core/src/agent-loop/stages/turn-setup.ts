import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type {
  AgentEvent,
  ModelDeviation,
  ModelResolutionFailure,
  ModelTierName,
  PersonalityConfig,
  ToolFilterOpts,
} from '@ethosagent/types';
import { deriveFsReachPaths, EmptySubstitutionError } from '../../fs-reach';
import { routeTurnModel } from '../model-route';
import { parseSmallWindowToolset } from '../small-window-toolset';
import type { LoopDeps, TurnSetupResult } from '../turn-context';
import { describeResolutionFailure, resolveTurnModel } from '../turn-model';

/**
 * Where a declaration that did not resolve lives, and the edit that fixes it —
 * appended to the D6/D14 refusal so it names a file and a line, not a concept.
 * Only for the DECLARATION failures: the role-binding and no-default failures
 * already carry their own fix from `resolveModel` (none of them lists
 * "Configured models:").
 */
function declarationFix(
  personality: PersonalityConfig,
  failure: ModelResolutionFailure,
  deps: LoopDeps,
  runOverride: string | undefined,
): string {
  if (failure.fix !== undefined && !failure.fix.includes('Configured models:')) return '';
  if (runOverride?.trim())
    return ' It came from this run’s model pin: pin a configured model instead.';
  const id = personality.id;
  if (Object.hasOwn(deps.modelResolution.routing, id)) {
    return ` It comes from \`modelRouting.${id}\` in ~/.ethos/config.yaml: set it to a configured model or a role.`;
  }
  const file = personality.soulFile
    ? join(dirname(personality.soulFile), 'config.yaml')
    : `the "${id}" personality's config.yaml`;
  return (
    ` To fix it, either add \`modelRouting.${id}: default\` to ~/.ethos/config.yaml (it outranks ` +
    `the personality's own declaration), or change the \`model\` lines in ${file} to a configured ` +
    `model or a role.`
  );
}

/**
 * Turn-setup stage: session resolve/create, personality, trace, budget-cap
 * check, turn counter, tier resolution, run_start event, tool filters,
 * session_start hook, credential gate.
 *
 * Yields AgentEvent while running; returns TurnSetupResult.
 */
export async function* setupTurn(
  deps: LoopDeps,
  text: string,
  opts: {
    sessionKey?: string;
    personalityId?: string;
    abortSignal?: AbortSignal;
    tierOverride?: ModelTierName;
    modelOverride?: string;
    toolsetOverride?: string[];
    toolsetNarrow?: string[];
    toolsetExclude?: string[];
  },
): AsyncGenerator<AgentEvent, TurnSetupResult> {
  const sessionKey = opts.sessionKey ?? `${deps.platform}:default`;

  // Step 1: Resolve or create session
  const existingSession = await deps.session.getSessionByKey(sessionKey);
  const ethosSession =
    existingSession ??
    (await deps.session.createSession({
      key: sessionKey,
      platform: deps.platform,
      model: deps.llm.model,
      provider: deps.llm.name,
      personalityId: opts.personalityId,
      workingDir: deps.workingDir,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        estimatedCostUsd: 0,
        apiCallCount: 0,
        compactionCount: 0,
      },
    }));

  const sessionId = ethosSession.id;

  // A session's personality is bound at creation and never changes. The
  // effective personality therefore comes from the SESSION, not from the
  // caller's per-turn `opts` — otherwise turn 2 of an existing session could
  // run as a different personality while the session row still names the
  // original, silently mixing two personalities into one transcript (which
  // `personality evolve` then reads back as training evidence).
  let effectivePersonalityId: string | undefined;
  if (!existingSession) {
    // Fresh session — this turn's personality is what it gets bound to.
    effectivePersonalityId = opts.personalityId;
  } else if (existingSession.personalityId) {
    if (opts.personalityId && opts.personalityId !== existingSession.personalityId) {
      yield {
        type: 'error',
        error: `Session ${sessionKey} is bound to personality "${existingSession.personalityId}". A session's personality cannot be changed. Start a new session as "${opts.personalityId}", or fork this one.`,
        code: 'personality_locked',
      };
      yield { type: 'done', text: '', turnCount: 0 };
      return { kind: 'refused' };
    }
    effectivePersonalityId = existingSession.personalityId;
  } else if (opts.personalityId) {
    // Legacy row created before the binding rule — bind it on first use rather
    // than refusing, so pre-existing sessions become immutable from here on.
    await deps.session.updateSession(sessionId, { personalityId: opts.personalityId });
    effectivePersonalityId = opts.personalityId;
  }

  const personality =
    (effectivePersonalityId ? deps.personalities.get(effectivePersonalityId) : null) ??
    deps.personalities.getDefault();

  const obsConfig = personality?.safety?.observability;

  const traceId = deps.observability?.startTurnTrace({
    sessionId,
    personalityId: personality?.id,
    obsConfig,
    // Gap 1 (P2-counters) — `ethos_turn_outcomes_total{platform,...}` reads
    // this back off the trace at close; previously never recorded.
    attrs: { platform: deps.platform },
  });

  // Budget cap check — refuse before any LLM work when the session has already
  // exceeded the personality's per-session spending limit.
  const currentSpend = deps.sessionCosts.get(sessionKey) ?? 0;
  if (personality.budgetCapUsd != null && currentSpend >= personality.budgetCapUsd) {
    if (traceId) deps.observability?.endTrace(traceId, 'error');
    deps.observability?.flush();
    yield {
      type: 'error',
      error: `Budget cap of $${personality.budgetCapUsd.toFixed(2)} exceeded for this session ($${currentSpend.toFixed(4)} spent). Use /budget reset to start a new budget window.`,
      code: 'BUDGET_EXCEEDED',
    };
    yield { type: 'done', text: '', turnCount: 0, ...(traceId ? { traceId } : {}) };
    return { kind: 'refused' };
  }

  // The turn's filesystem reach — working directory AND read/write allowlist,
  // from ONE derivation. `fs_reach` is a personality declaration and the
  // personality resolves per turn, so the derivation lives here rather than on
  // the loop; `deps.workingDir` is the boot-time cwd an undeclared personality
  // keeps. The whole result is threaded on `TurnSetup` because the derivation
  // is not idempotent: re-deriving downstream with the resolved workdir as
  // `cwd` would compound a declared `${CWD}/...` workdir.
  //
  // `deriveFsReachPaths` throws `EmptySubstitutionError` when a DECLARED path
  // names a substitution variable that resolves to empty — a configuration
  // error, and previously an exception thrown mid-turn out of the tool stage.
  // Refuse the turn the way this stage already refuses a blown budget cap or a
  // missing credential: error event, done, `refused` — before
  // `recordTurnStart` burns a turn number.
  let workingDir: string;
  let fsReach: { read: string[]; write: string[] };
  try {
    const derived = deriveFsReachPaths(personality, {
      ethosHome: deps.dataDir ?? join(homedir(), '.ethos'),
      self: personality.id,
      cwd: deps.workingDir,
    });
    workingDir = derived.workdir;
    fsReach = { read: derived.read, write: derived.write };
  } catch (err) {
    if (!(err instanceof EmptySubstitutionError)) throw err;
    if (traceId) deps.observability?.endTrace(traceId, 'error');
    deps.observability?.flush();
    yield {
      type: 'error',
      error: `Personality "${personality.id}" has an unusable fs_reach: ${err.message}`,
      code: 'FS_REACH_INVALID',
    };
    yield { type: 'done', text: '', turnCount: 0, ...(traceId ? { traceId } : {}) };
    return { kind: 'refused' };
  }

  // Q2 — advance the per-session turn counter. `turnNumber` drives the
  // anti-thrashing compaction cooldown; `lastCompactionTurn` is the turn the
  // previous compaction fired (0 = never).
  const { turnNumber, lastCompactionTurn } = await deps.session.recordTurnStart(sessionId);

  // Resolve the model this turn runs on — the six rungs of D7, through the ONE
  // resolver (`resolveModel`, reached via `resolveTurnModel`, which adds the
  // D11b shim for a deployment that has no registry yet).
  // A tier override (from /tier command via RunOptions) is the ROLE asked for,
  // and applies for this entire turn.
  const turnTierOverride = opts.tierOverride;
  if (turnTierOverride) {
    deps.observability?.recordTierOverride({
      traceId: traceId ?? '',
      actor: 'user',
      tier: turnTierOverride,
      personalityId: personality.id,
    });
  }

  const activeTier = turnTierOverride ?? 'default';
  // An explicit per-run model pin is rung 0 — it outranks the manifest, the
  // routing override, the personality's own declaration and the deployment
  // default. A caller naming a model for one turn knows something no static
  // declaration does, and `source: 'run-override'` now says so rather than
  // borrowing the `personality` label the frozen union used to force.
  const turnModel = resolveTurnModel({
    personality,
    role: activeTier,
    ctx: deps.modelResolution,
    ...(opts.modelOverride ? { runOverride: opts.modelOverride } : {}),
    llmName: deps.llm.name,
    llmModel: deps.llm.model,
  });

  // D6/D14 — the declaration names a model this machine does not have, so
  // nothing runs. A refusal, never a silent reroute: substituting another model
  // changes the agent while keeping its name, and the substitution is
  // discovered on the invoice. The personality itself still LOADED — its
  // toolset, memory and skills are intact; only the turn is refused.
  if (turnModel.ok === false) {
    if (traceId) deps.observability?.endTrace(traceId, 'error');
    deps.observability?.flush();
    yield {
      type: 'error',
      error:
        describeResolutionFailure(personality.id, turnModel) +
        declarationFix(personality, turnModel, deps, opts.modelOverride),
      code: 'model_unresolved',
    };
    yield { type: 'done', text: '', turnCount: 0, ...(traceId ? { traceId } : {}) };
    return { kind: 'refused' };
  }

  const effectiveModel = turnModel.model;
  // What reaches `CompletionOptions.modelOverride` / `.providerEntry` (D21,
  // D23b): compared against the provider ENTRY the model names, never against
  // `deps.llm.model`, which on a chain moves with cooldown state
  // (`routeTurnModel`). Selecting a provider OUTSIDE the loop's LLM is
  // T1.20 (`LoopDeps.providerFor`); until then an entry the loop cannot reach
  // refuses rather than being sent to whichever provider it holds.
  const route = routeTurnModel(deps.llm, turnModel, deps.modelResolution);
  if (!route.ok) {
    if (traceId) deps.observability?.endTrace(traceId, 'error');
    deps.observability?.flush();
    yield { type: 'error', error: route.reason, code: 'model_unresolved' };
    yield { type: 'done', text: '', turnCount: 0, ...(traceId ? { traceId } : {}) };
    return { kind: 'refused' };
  }
  const { modelOverride, providerEntry } = route;

  // D17 — the `once` suppression set, owned by the loop instance. A config fact
  // (an unbound role, a manifest outranking a declaration) is true until
  // someone edits a file, so repeating it every turn trains people to stop
  // reading it; a live condition (`once: false`) is announced every time.
  let deviation: ModelDeviation | undefined = turnModel.deviation;
  if (deviation?.once) {
    // NUL-joined: a separator no id, no kind and no declared value can
    // contain, so two different triples cannot collide into one suppression.
    const key = `${personality.id}\u0000${deviation.kind}\u0000${deviation.declared}`;
    if (deps.deviationSeen.has(key)) deviation = undefined;
    else deps.deviationSeen.set(key, true);
  }

  // Phase 5: emit run_start trace so consumers (TUI, CLI verbose, telemetry)
  // can surface the resolved provider/model and routing source.
  // B3 — the turn's `traceId` rides `run_start` so a surface that only sees the
  // event stream can name the turn (and join it to `observability.db`) before
  // any output arrives. Omitted when no observability adapter is wired.
  yield {
    type: 'run_start',
    provider: turnModel.provider,
    model: effectiveModel,
    source: turnModel.source,
    ...(deviation ? { deviation } : {}),
    ...(traceId ? { traceId } : {}),
  };

  // Allowed tool names for this personality (undefined = no restriction)
  const baseToolset = opts.toolsetOverride ?? personality.toolset ?? undefined;
  const narrow = opts.toolsetNarrow;
  let allowedTools =
    narrow && baseToolset ? baseToolset.filter((t) => narrow.includes(t)) : (narrow ?? baseToolset);

  // Lane 3(b) / D20 — declared small-window toolset narrowing. When wiring
  // resolved small-window mode AND this turn's personality declares
  // `context_engine_options.small_window_toolset`, the effective toolset is
  // the declared set (intersected — a declaration can never escalate beyond
  // the allowlist computed above). `allowedTools` gates BOTH toDefinitions()
  // and executeParallel downstream, so a narrowed-out tool is rejected exactly
  // like a disallowed one. Static per loop + personality — never per turn —
  // so the tool payload in the request prefix stays byte-stable.
  if (deps.smallWindow) {
    const declared = parseSmallWindowToolset(
      personality.context_engine_options?.small_window_toolset,
    );
    if (declared) {
      allowedTools = allowedTools ? allowedTools.filter((t) => declared.includes(t)) : declared;
    }
  }
  // Per-personality plugin + MCP gate (default-deny: missing field = no access)
  const allowedPlugins = personality.plugins ?? [];

  // Build per-tool MCP allowlist from mcp.yaml policy (if present).
  const mcpServers = deps.mcpPolicy?.servers;
  const allowedMcpTools: Record<string, string[]> | undefined = mcpServers
    ? Object.fromEntries(
        Object.entries(mcpServers)
          .filter(([, v]) => v.tools !== undefined || v.enabled === false)
          .map(([k, v]) => {
            if (v.enabled === false) return [k, []];
            const tools = v.tools;
            return [k, tools ?? []];
          }),
      )
    : undefined;

  // Surface exclusion is deliberately NOT folded into `allowedTools`: it must
  // outrank `alwaysInclude` and reach MCP/plugin tools too, which only the
  // filterOpts path does. Static per surface, so tool definitions stay
  // byte-identical across turns (see tool-definition-stability.test.ts).
  const filterOpts: ToolFilterOpts = {
    allowedMcpServers: personality.mcp_servers ?? [],
    allowedPlugins,
    ...(allowedMcpTools && Object.keys(allowedMcpTools).length > 0 ? { allowedMcpTools } : {}),
    ...(opts.toolsetExclude ? { excludeTools: opts.toolsetExclude } : {}),
  };

  // Step 2: Fire session_start hooks
  await deps.hooks.fireVoid(
    'session_start',
    {
      sessionId,
      sessionKey,
      platform: deps.platform,
      personalityId: personality.id,
    },
    allowedPlugins,
  );

  // v2.2: Pre-turn credential check — surface a credential_required event
  // before the LLM call so the host can prompt the user for auth.
  if (deps.credentialCheck) {
    const missing = await deps.credentialCheck(sessionKey, text);
    if (missing) {
      if (traceId) deps.observability?.endTrace(traceId, 'error');
      deps.observability?.flush();
      yield {
        type: 'credential_required',
        pluginId: missing.pluginId,
        credentialKey: missing.credentialKey,
        kind: missing.kind,
        label: missing.label,
        description: missing.description,
        authUrl: missing.authUrl,
        sessionKey,
        pendingUserMessage: text,
      };
      yield { type: 'done', text: '', turnCount: 0, ...(traceId ? { traceId } : {}) };
      return { kind: 'refused' };
    }
  }

  const memScopeId = `personality:${personality.id}`;

  return {
    kind: 'ready',
    setup: {
      sessionId,
      sessionKey,
      personality,
      workingDir,
      fsReach,
      obsConfig,
      traceId,
      turnNumber,
      lastCompactionTurn,
      activeTier,
      effectiveModel,
      modelOverride,
      providerEntry,
      allowedTools,
      allowedPlugins,
      filterOpts,
      memScopeId,
    },
  };
}
