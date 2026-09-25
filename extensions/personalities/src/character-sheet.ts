import {
  type ConstitutionEnforcement,
  derivedCallTreatment,
  type ExecutionPosture,
  GUARANTEE_IDS,
  type GuaranteeId,
  type PersonalityConfig,
  resolveModelDisplay,
} from '@ethosagent/types';
import { parseLivingSoul } from './living-soul';
import {
  bulletList,
  type CharacterSheetMcpExport,
  filesystemReachLines,
  mcpExportSection,
  mcpServersLines,
  permissionSurface,
  pluginsLines,
  publishingLine,
  toolsetLines,
} from './permission-surface';
import { normalizeWorkdir } from './workdirs';

// The generated character sheet — the "tight character sheet" promise from
// SOUL.md made into a real artifact. One Markdown screen per personality:
// what it is, what it has, what it can reach. Regenerated on demand from
// the personality's config + SOUL.md; never stored. The CLI
// (`ethos personality show`) and the Web Personalities tab both render
// this single source.

/**
 * The prose directly under the SOUL.md title — the personality's own
 * voice describing who it is. Returns `''` when the document has no body
 * paragraph (heading-only or empty file). Exported so surfaces that build
 * their own character-sheet rendering (e.g. the Slack `/ethos personality
 * rich` card) extract the identity line the same way the canonical sheet
 * does.
 */
export function firstParagraph(soulMd: string): string {
  const para: string[] = [];
  for (const line of soulMd.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#')) continue; // skip heading lines
    if (trimmed === '') {
      if (para.length > 0) break; // blank line closes the first paragraph
      continue; // skip leading blank lines
    }
    para.push(trimmed);
  }
  return para.join(' ');
}

// Rough char/4 token estimate for the injection-defense prelude — a static
// system-prompt component the character sheet cannot see directly. Kept as a
// constant so the estimate approximates the assembled prompt without pulling in
// a cross-package dependency on @ethosagent/safety-injection.
const PRELUDE_TOKEN_ESTIMATE = 340;

/**
 * Estimate the assembled system-prompt token count from the components the
 * character sheet already carries: the injection prelude, SOUL.md, and the
 * toolset names. char/4 rule of thumb — deliberately an under-estimate (no tool
 * schemas, no memory), labeled `~` in the sheet.
 */
function estimateSystemPromptTokens(soulMd: string, toolset: readonly string[]): number {
  const chars = soulMd.length + toolset.join(', ').length;
  return PRELUDE_TOKEN_ESTIMATE + Math.ceil(chars / 4);
}

/**
 * Lane 6 (eng review D5/D19) — the arithmetic model-fit verdict, as PLAIN DATA.
 * Computed by `computeModelFit()` in `@ethosagent/wiring` (which can see the
 * tool registry, the provider, and the window resolution) and passed in here;
 * the personalities package never reaches up into wiring. One generator renders
 * it for both the CLI (`ethos personality show`) and the
 * `personalities.characterSheet` RPC.
 */
export interface CharacterSheetModelFit {
  verdict: 'fits' | 'fits-degraded' | 'refuses' | 'unknown';
  /** Model the verdict was computed against. */
  model: string;
  /** Resolved served window in tokens. Absent → unresolved (verdict `unknown`);
   *  the verdict is NEVER computed against the 128,000-token default (D19). */
  windowTokens?: number;
  /** Where the window number came from. `default` = nothing resolved. */
  windowSource: 'config' | 'probe' | 'catalog' | 'default';
  /** Static-floor breakdown from `measureStaticFloor()` — serialized tool-schema
   *  size, not toolset name count (D8). */
  floor: {
    tokens: number;
    toolCount: number;
    components: Array<{ name: string; tokens: number }>;
    /** The AGENTS.md/CLAUDE.md project-context block counted in `tokens`,
     *  measured in the personality's declared `fs_reach` workdir. `workdir`
     *  absent → the personality has none, its project context depends on the
     *  directory it runs in, and `tokens` is 0. Absent → not measured. */
    projectContext?: { workdir?: string; tokens: number };
  };
  outputReserveTokens?: number;
  /** `window − output reserve − static floor`; ≤ 0 → `refuses`. */
  compactibleTokens?: number;
  /** `floor.tokens / windowTokens`, when the window is known. */
  staticShare?: number;
  /** Named arithmetic costs in effect (small-window mode, narrowed toolset,
   *  static share over the budget ratio). Non-empty → `fits-degraded`. */
  degradations: string[];
  /** The Lane 1(b) diagnostic — set on `refuses`, names the largest component. */
  refusalReason?: string;
  /** What the arithmetic could not see (MCP schemas, tier models). */
  exclusions: string[];
}

/** Render the `## Model fit` block. Pure — takes the computed verdict data. */
function modelFitSection(fit: CharacterSheetModelFit): string[] {
  const n = (v: number) => v.toLocaleString('en-US');
  const lines: string[] = ['## Model fit'];
  lines.push(`- Verdict: ${fit.verdict}`);
  lines.push(`- Model: ${fit.model}`);
  // D19 — every verdict prints its inputs: the window and its source. An
  // unresolved window prints "unknown", never a fallback number.
  if (fit.windowTokens !== undefined) {
    lines.push(`- Window: ${n(fit.windowTokens)} tokens (source: ${fit.windowSource})`);
  } else {
    lines.push(
      '- Window: unknown (no config, no probe, no catalog — verdict not computed against the default)',
    );
  }
  lines.push(
    `- Static floor: ${n(fit.floor.tokens)} tokens (${fit.floor.toolCount} tool schema${
      fit.floor.toolCount === 1 ? '' : 's'
    }):`,
  );
  for (const comp of fit.floor.components) {
    lines.push(`    - ${comp.name}: ${n(comp.tokens)} tokens`);
  }
  if (fit.outputReserveTokens !== undefined) {
    lines.push(`- Output reserve: ${n(fit.outputReserveTokens)} tokens`);
  }
  if (fit.compactibleTokens !== undefined) {
    lines.push(`- Compactible: ${n(fit.compactibleTokens)} tokens`);
  }
  if (fit.staticShare !== undefined) {
    lines.push(`- Static share of window: ${Math.round(fit.staticShare * 100)}%`);
  }
  if (fit.degradations.length > 0) {
    lines.push('- Degradations:');
    for (const d of fit.degradations) lines.push(`    - ${d}`);
  }
  if (fit.refusalReason) lines.push(`- Refusal: ${fit.refusalReason}`);
  if (fit.exclusions.length > 0) {
    lines.push('- Exclusions:');
    for (const e of fit.exclusions) lines.push(`    - ${e}`);
  }
  return lines;
}

/**
 * Lane 5(i) follow-on — WHICH MODEL A TURN ACTUALLY SENDS, as PLAIN DATA.
 *
 * A personality's declared `model` is not automatically the model that runs.
 * A declaration is an alias or a role resolved against the deployment's
 * `modelRegistry` (`resolveTurnModel`,
 * `packages/core/src/agent-loop/turn-model.ts`), and on a deployment that has
 * no registry yet every declaration falls through to the deployment's global
 * model. Without this block the sheet printed the DECLARED value as fact, so a
 * deployment running `codex` still read `claude-sonnet-4-6`.
 *
 * Computed by `resolveCharacterSheetRouting()` in `@ethosagent/wiring` (which
 * calls that same resolver, so the sheet cannot claim a model the turn would
 * not send) and passed in here; the personalities package never reaches up
 * into wiring. Absent → the sheet renders the declared value exactly as it did
 * before, which is all a caller that cannot see the active LLM is entitled to
 * claim.
 */
export type CharacterSheetRouting = {
  /** `LLMProvider.name` of the active LLM. */
  activeProvider: string;
  /** The rung that DECLARED the model: a `modelRouting` entry, the
   *  personality's own `model:`, or nothing (the deployment default). */
  source: 'personality' | 'global' | 'routing-override';
  /** Set when the personality declares a model a turn does not use: what it
   *  declared, and why. */
  inert?: { declared: string; reason: string };
  /** A deviation the resolver attached to this personality's own declaration
   *  (today only D17 row 7, a legacy vendor id the D11c shim mapped), already
   *  rendered through `describeDeviation` — the sheet does not restate the copy. */
  notice?: string;
} & (
  | {
      /** The vendor model id a turn will actually send. */
      effectiveModel: string;
      /** The registry alias that resolved. Absent on a deployment with no
       *  registry, where the model is the raw configured id. */
      alias?: string;
      /** The role the resolution went through, when it went through one.
       *  `bound: false` → nothing is bound to it and `alias` is the default. */
      role?: { name: string; bound: boolean };
      refusal?: undefined;
    }
  | {
      /** Nothing resolves, so a turn is refused — the refusal a turn shows
       *  (`describeResolutionFailure`, `packages/core/src/agent-loop/turn-model.ts`). */
      refusal: string;
      effectiveModel?: undefined;
    }
);

const ROUTING_SOURCE_LABEL: Record<CharacterSheetRouting['source'], string> = {
  personality: "declared in this personality's config.yaml",
  global: 'deployment default',
  'routing-override': 'modelRouting override in config.yaml',
};

/** The `- Model:` line: the resolved id, then how it was reached. Pure. */
function modelLine(routing: CharacterSheetRouting): string {
  const label = ROUTING_SOURCE_LABEL[routing.source];
  if (routing.refusal !== undefined)
    return `- Model: does not resolve — turns are refused (${label})`;
  const how: string[] = [];
  if (routing.role && !routing.role.bound) {
    how.push(
      `via role \`${routing.role.name}\` (unbound, using default \`${routing.alias ?? '?'}\`)`,
    );
  } else {
    if (routing.alias) how.push(`alias \`${routing.alias}\``);
    if (routing.role) how.push(`via role \`${routing.role.name}\``);
  }
  const detail = how.length > 0 ? `${how.join(', ')}; ${label}` : label;
  return `- Model: ${routing.effectiveModel} (${detail})`;
}

/** Render the `- Model:` / `- Provider:` pair of `## Routing`. Pure. */
function routingLines(
  config: PersonalityConfig,
  routing: CharacterSheetRouting | undefined,
): string[] {
  if (!routing) {
    return [
      `- Model: ${resolveModelDisplay(config.model, '(engine default)')}`,
      `- Provider: ${config.provider ?? '(engine default)'}`,
    ];
  }
  const lines = [modelLine(routing)];
  if (routing.refusal !== undefined) lines.push(`- Refusal: ${routing.refusal}`);
  if (routing.notice !== undefined) lines.push(`- Notice: ${routing.notice}`);
  if (routing.inert) {
    lines.push(`- Declared model: ${routing.inert.declared} — not used: ${routing.inert.reason}`);
  }
  const declaredProvider = config.provider ?? '(engine default)';
  lines.push(
    config.provider === routing.activeProvider
      ? `- Provider: ${declaredProvider}`
      : `- Provider: ${declaredProvider} (active LLM: ${routing.activeProvider})`,
  );
  return lines;
}

/** One decision site as the sheet shows it (plan decision-provider-personality §4.5). */
export interface CharacterSheetDecisionSite {
  site: 'injection' | 'approver' | 'router';
  /** What the personality's `decisions.sites.<site>` asked for (`off` when unset). */
  requested: 'off' | 'shadow' | 'on';
  /** What runs. */
  effective: 'off' | 'shadow' | 'on';
  /** `resolvePersonalityDecisionSite`'s reason (packages/config/src/decisions.ts). */
  reason?: 'undeclared' | 'no-provider' | 'not-configured' | 'threshold-missing';
  /** Threshold keys whose absence ran `on` as `shadow` (R6). */
  missingThresholds: readonly string[];
  /** Set when the approver is requested but `safety.approvalMode` (this value)
   *  is not `smart`, so it is never consulted (plan §4.3 `inert-approval-mode`). */
  inertApprovalMode?: string;
}

/**
 * The RESOLVED `## Decisions` context — per site, what the personality asked
 * for and what runs on this machine. Computed by
 * `resolveCharacterSheetDecisions()` in `@ethosagent/wiring`, which calls
 * `resolvePersonalityDecisionSite` (packages/config/src/decisions.ts), the
 * resolver the three live sites call, so the sheet cannot claim a mode a call
 * would not run. `ethos doctor` reads the same function. Absent → the section
 * prints the declared values only.
 */
export interface CharacterSheetDecisions {
  /** The personality's `decisions.provider`, verbatim. Absent → nothing runs (PD10). */
  provider?: string;
  /** The operator configured THIS provider (`decisions.provider` in ~/.ethos/config.yaml). */
  configured: boolean;
  /** Set when `configured`: where request bodies go, and the pinned model. */
  host?: string;
  model?: string;
  /** Set when `configured`: the vault ref the key is read from, and whether it holds one. */
  apiKeyRef?: string;
  apiKeyPresent?: boolean;
  sites: readonly CharacterSheetDecisionSite[];
}

const SHEET_DECISION_SITES = ['injection', 'approver', 'router'] as const;

/** `## Decisions` — rendered only when the personality declares `decisions`. Pure. */
function decisionsSection(
  declared: NonNullable<PersonalityConfig['decisions']>,
  resolved: CharacterSheetDecisions | undefined,
): string[] {
  const lines: string[] = ['## Decisions'];
  if (!resolved) {
    lines.push(`- Decision model: ${declared.provider ?? '(none)'}`);
    for (const site of SHEET_DECISION_SITES) {
      lines.push(`- ${site}: ${declared.sites?.[site] ?? 'off'}`);
    }
    return lines;
  }
  if (resolved.provider === undefined) {
    lines.push('- Decision model: (none) — sites need `decisions.provider`; every site runs off');
  } else if (!resolved.configured) {
    lines.push(
      `- Decision model: ${resolved.provider} — not configured on this machine; every site runs off`,
    );
  } else {
    let line = `- Decision model: ${resolved.provider} → ${resolved.host ?? '?'} · model ${resolved.model ?? '?'}`;
    if (resolved.apiKeyPresent === false) {
      line += ` — no key at vault ref ${resolved.apiKeyRef ?? '?'}; every site runs today's path`;
    }
    lines.push(line);
    // plan decision-tool D15 — the same two inputs as the loop's gate
    // (`decisionToolEnabled`, packages/config/src/decisions.ts).
    lines.push('- tool: decide (via decision model)');
  }
  for (const s of resolved.sites) {
    let line = `- ${s.site}: ${s.requested}`;
    if (s.reason === 'threshold-missing') {
      const keys = s.missingThresholds.map((k) => `\`${k}\``).join(', ');
      line += ` → running ${s.effective}: ${keys} missing`;
    } else if (s.effective !== s.requested) {
      line += ` → ${s.effective}`;
    }
    if (s.inertApprovalMode !== undefined) {
      line += ` — inert: approvalMode is ${s.inertApprovalMode}; the approver runs only under smart`;
    }
    lines.push(line);
  }
  return lines;
}

/**
 * Optional context for the `## Execution` section. The renderer is pure: it
 * formats whatever posture the caller resolved (via the wiring posture
 * resolver) and the constitution enforcement it loaded. When `posture` is
 * absent the section is omitted entirely (e.g. surfaces that don't resolve
 * execution).
 */
export interface CharacterSheetExecution {
  posture: ExecutionPosture;
  /** Operator constitution enforcement — surfaces clamp notices for this id. */
  enforcement?: ConstitutionEnforcement;
  /**
   * Host platform exec will run on (`process.platform`). Drives the #7 macOS
   * caveat. Injectable for tests; defaults to the current platform.
   */
  platform?: NodeJS.Platform;
}

const POSTURE_LABEL: Record<ExecutionPosture['backend'], string> = {
  docker: 'docker (sandboxed)',
  local: 'local (un-sandboxed — runs in this process)',
  ssh: 'ssh (remote host)',
  none: 'none (no execution backend)',
};

/**
 * What the PERSONALITY asked for, in the same voice as the posture label. Kept
 * separate from `POSTURE_LABEL` on purpose: a requirement and a transport are
 * different questions, and the sheet's job here is to let an operator read both
 * answers side by side — "this agent's work belongs elsewhere" above "and here
 * is where it actually goes".
 */
const REQUIREMENT_LABEL: Record<'remote' | 'none', string> = {
  remote: "remote (another machine — the transport is the operator's)",
  none: 'none (this personality does not execute)',
};

/**
 * The one posture label. Used by `## Execution` and by the `G-EXEC` row of
 * `## Boundary`, so the boundary summary cannot describe the posture in
 * different words from the section it summarises.
 */
function postureLabelFor(posture: ExecutionPosture): string {
  if (posture.containerized) return 'containerized (local)';
  // F1/P2 — a sandbox/remote backend was wanted but unavailable; execution
  // honestly runs on the host. Never claim "Sandboxed · Docker" or
  // "ssh (remote host)" while running un-sandboxed on the host.
  if (posture.hostFallback) {
    return posture.hostFallback.reason === 'ssh-unavailable'
      ? 'local (un-sandboxed — runs on host; ssh backend unavailable)'
      : 'local (un-sandboxed — runs on host; Docker unavailable)';
  }
  return POSTURE_LABEL[posture.backend];
}

/** Render the `## Execution` block. Pure — takes the resolved posture + context. */
function executionSection(config: PersonalityConfig, exec: CharacterSheetExecution): string[] {
  const { posture, enforcement } = exec;
  const platform = exec.platform ?? process.platform;
  const lines: string[] = ['## Execution'];

  // What was ASKED FOR, then what this deployment actually provides. Both, in
  // that order, always — an operator reading only the posture cannot tell a
  // refused `remote` requirement apart from a personality that never executed.
  lines.push(
    `- Required:   ${
      posture.requirement
        ? REQUIREMENT_LABEL[posture.requirement]
        : '(none declared — the deployment chooses)'
    }`,
  );
  lines.push(`- Posture:    ${postureLabelFor(posture)}`);
  lines.push(`- Network:    ${posture.networkMode}`);
  lines.push(`- Memory cap: ${posture.memoryMb} MB`);

  // Mounts + the ${CWD} blast radius (A7): the rw mount roots are the writable
  // host paths a shell escape could damage.
  if (posture.backend === 'docker') {
    if (posture.mounts.length > 0) {
      lines.push(`- Mounts (${posture.mounts.length}):`);
      for (const m of posture.mounts) {
        lines.push(`    - ${m.hostPath} (${m.mode})`);
      }
    } else {
      lines.push('- Mounts:     (default — personality directory + cwd)');
    }
    for (const scratch of posture.scratchPaths) {
      lines.push(`    - ${scratch} (ephemeral scratch, wiped on exit)`);
    }
    const rwRoots = posture.mounts.filter((m) => m.mode === 'rw').map((m) => m.hostPath);
    lines.push(
      `- Write blast radius (A7): ${
        rwRoots.length > 0 ? rwRoots.join(', ') : '(none — read-only mounts)'
      }`,
    );
  }

  // Containerized note (mirrors the honest trade in the plan).
  if (posture.containerized) {
    lines.push(
      '- Containerized: isolation boundary = the Ethos container; fs_reach + network',
      '  enforced app-layer only, shared across personalities in this process.',
    );
  }

  // ssh relabel (A3) — remote-host trust, NOT mount-confinement.
  if (posture.backend === 'ssh') {
    lines.push('- Note (A3): ssh = remote-host trust — NOT mount-confined.');
    if (posture.sshTarget) {
      // Exactly what the operator configured — `formatSshTarget` prints no
      // guessed user or port, so the sheet never shows a value they never set.
      lines.push(`- ssh target: ${posture.sshTarget}`);
      // D4 — the honest cost of remoting `terminal` while file tools stay local.
      // Stated plainly: there is no remote path floor, so this is an
      // unrestricted shell on another machine.
      lines.push(
        '- Note (D4): file tools operate on THIS host; terminal runs on the remote',
        '  target with NO path floor — an unrestricted shell on another machine.',
      );
    } else if (!posture.sshRefused) {
      // A target IS configured (an unconfigured one always carries a refusal)
      // but this surface was not handed its address. Say that, rather than let
      // the missing line read as "no target".
      lines.push('- ssh target: (configured, but this surface was not given the address)');
    }
    // The refusal wording comes from the resolver, verbatim — one explanation,
    // one source, so the sheet cannot drift from the reason exec tools refused.
    if (posture.sshRefused) {
      lines.push(`- ${posture.sshRefused.message}`);
    }
  }

  // #7 macOS caveat — docker on macOS is best-effort, not a hard boundary.
  if (posture.backend === 'docker' && platform === 'darwin') {
    lines.push(
      '- macOS (#7): boundary is best-effort via Docker Desktop’s VM —',
      '  best-effort, NOT a hard security boundary. Rootless/gVisor is deferred.',
    );
  }

  // F1 honest host fallback — Docker wanted but disabled/unavailable in this
  // process, constitution permits local, so execution runs un-sandboxed on the
  // host. Surfaced so the UI never claims a sandbox it doesn't have.
  if (posture.hostFallback) {
    let why: string;
    let tag: string;
    if (posture.hostFallback.reason === 'docker-disabled') {
      why = 'Docker execution is disabled in this process';
      tag = 'F1';
    } else if (posture.hostFallback.reason === 'ssh-unavailable') {
      why = 'no ssh execution backend is wired in this build';
      tag = 'P2';
    } else {
      why = 'the Docker daemon is unavailable';
      tag = 'F1';
    }
    lines.push(
      `- Host fallback (${tag}): ${why}; running un-sandboxed on the host (constitution permits local).`,
    );
  }

  // A1 docker-absent decision state — surfaced, never a silent fallback.
  if (posture.dockerAbsent) {
    lines.push('- Docker required but not running (A1):');
    lines.push('    - Option: install/start Docker');
    if (posture.dockerAbsent.canConsentLocal) {
      lines.push('    - Option: run un-sandboxed on host (explicit consent required)');
    } else {
      lines.push(
        `    - Un-sandboxed consent withheld: ${
          posture.dockerAbsent.consentForbiddenReason ?? 'forbidden by the constitution'
        }`,
      );
    }
  }

  // Constitution clamp notices (from D1 enforcement) for THIS personality.
  const clamps = (enforcement?.clamps ?? []).filter((c) => c.personalityId === config.id);
  for (const clamp of clamps) {
    lines.push(`- Constitution clamp: ${clamp.field} ${clamp.declared} → ${clamp.clamped}`);
  }

  return lines;
}

/**
 * tools-as-code-api Lane G — the script-callable tool surface, as PLAIN DATA.
 * Computed by callers via `scriptCallableFor()` from `@ethosagent/core` — the
 * SAME derivation the ScriptToolBridge enforces, so the displayed surface
 * cannot drift from the enforced one. Passed in like `CharacterSheetModelFit`:
 * the personalities package never reaches into core/wiring for a registry.
 * Absent (no live tool registry at the call site) → the line is omitted,
 * mirroring the fail-soft `## Model fit` behaviour.
 */
export interface CharacterSheetScriptSurface {
  /** Sorted tool names from `scriptCallableFor(personality, registry)`. */
  callable: readonly string[];
}

/**
 * §4.7 — what this surface knows about the personality's reach that the config
 * alone cannot say. Today one field, computed by callers via
 * `toolsDeclaringNetwork()` from `@ethosagent/core` (the SAME `capabilities`
 * declaration G-CAP intersects per call), passed in as PLAIN DATA like
 * `CharacterSheetScriptSurface`. Absent (no live tool registry at the call
 * site) → the sheet does not claim a guarantee is inapplicable; it reports the
 * enforced/configured state and says nothing it cannot see.
 */
export interface CharacterSheetBoundary {
  /** Built-in tools in this personality's toolset that declare network reach. */
  networkTools: readonly string[];
}

/**
 * Status of ONE published guarantee for ONE personality.
 *
 * - `enforced` — the kernel enforces it and nothing in this personality's
 *   configuration changes it.
 * - `narrowed` — enforced, and this personality tightens it (a smaller toolset,
 *   a declared `fs_reach`, a host allowlist, extra redaction patterns).
 * - `relaxed`  — enforced floor still holds, but this personality widens or
 *   disables something above it. NOT a waiver: no register guarantee can be
 *   switched off, and the row says what still runs.
 * - `n/a`      — nothing in this personality reaches the guarantee: no tool that
 *   could trigger it, or its state is decided outside the personality entirely.
 */
type GuaranteeStatus = 'enforced' | 'narrowed' | 'relaxed' | 'n/a';

interface GuaranteeRow {
  status: GuaranteeStatus;
  /** One line. What is true for THIS personality — never the register's prose. */
  detail: string;
}

function joinParts(parts: string[]): string {
  return parts.filter((p) => p !== '').join('; ');
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/**
 * Derive every register row's status from the personality's RESOLVED
 * configuration plus whatever this surface resolved for it (execution posture,
 * script surface, declared network reach). Keyed by `GuaranteeId`, so a
 * thirteenth register row fails to compile here until it is given a status —
 * the sheet cannot silently stop covering the register.
 */
function guaranteeRows(
  config: PersonalityConfig,
  execution?: CharacterSheetExecution,
  scriptSurface?: CharacterSheetScriptSurface,
  boundary?: CharacterSheetBoundary,
): Record<GuaranteeId, GuaranteeRow> {
  const safety = config.safety;
  const toolset = config.toolset;
  const mcpCount = config.mcp_servers?.length ?? 0;
  const pluginCount = config.plugins?.length ?? 0;
  // MCP servers and plugins reach out of this process on their own terms — a
  // plugin runs in-process with full Node privileges — so their presence is
  // enough to refuse an "inapplicable" verdict for reach-shaped guarantees.
  const thirdPartyCode = mcpCount > 0 || pluginCount > 0;

  // G-TOOLS — the allowlist is always double-enforced; what varies is whether
  // this personality declared one at all.
  let tools: GuaranteeRow;
  if (toolset === undefined) {
    tools = {
      status: 'relaxed',
      detail: 'no toolset declared — every registered built-in tool is reachable',
    };
  } else {
    const script =
      toolset.includes('run_code') && scriptSurface
        ? `${scriptSurface.callable.length} script-callable`
        : '';
    tools = {
      status: 'narrowed',
      detail: joinParts([
        `${plural(toolset.length, 'tool')} allowed, re-checked at execution`,
        script,
      ]),
    };
  }

  // A `*` entry matches every host (`hostnameMatches`,
  // packages/safety/network/src/policy.ts), so a list containing one is the
  // open policy, not an allowlist — `defaultRecipeSafety` writes exactly that.
  const netAllow = safety?.network?.allow;
  const hostAllowlist = netAllow && netAllow.length > 0 && !netAllow.includes('*') ? netAllow : [];

  // G-CAP — always enforced per call; the personality's own policy is what the
  // declaration is intersected WITH.
  const capNarrowings = [
    config.fs_reach ? 'fs_reach' : '',
    hostAllowlist.length > 0 ? 'network allowlist' : '',
  ].filter((p) => p !== '');
  const cap: GuaranteeRow = {
    status: capNarrowings.length > 0 ? 'narrowed' : 'enforced',
    detail: joinParts([
      'tool declarations ∩ personality policy, resolved per call',
      capNarrowings.length > 0 ? `intersected with ${capNarrowings.join(' + ')}` : '',
    ]),
  };

  // G-FS — the floor is always on; a declared reach replaces the default scope.
  const reach = config.fs_reach;
  const readCount = reach?.read?.length ?? 0;
  const writeCount = reach?.write?.length ?? 0;
  // `, `-joined, the same form `renderConfigYaml` writes and `parseCsv` reads
  // back. An empty array declares nothing, so it reads as an absent workdir
  // rather than a dangling label.
  const workdirs = normalizeWorkdir(reach?.workdir);
  const fs: GuaranteeRow = reach
    ? {
        status: 'narrowed',
        detail: joinParts([
          `declared reach: ${readCount} read / ${writeCount} write prefix${
            readCount + writeCount === 1 ? '' : 'es'
          } (see Filesystem reach)`,
          workdirs.length > 0
            ? `workdir${workdirs.length === 1 ? '' : 's'} ${workdirs.join(', ')}`
            : '',
        ]),
      }
    : {
        status: 'enforced',
        detail: 'default reach: own directory, ~/.ethos/skills/, working directory',
      };

  // G-NET — the safeFetch floor is not overridable from above it; the two
  // things a personality can do are narrow the destination set and opt into
  // private-network destinations.
  const net = safety?.network;
  let netRow: GuaranteeRow;
  if (boundary && boundary.networkTools.length === 0 && !thirdPartyCode) {
    netRow = { status: 'n/a', detail: 'no tool in this toolset declares network reach' };
  } else {
    // Every part that is true is stated: a personality can both narrow the
    // destination set AND opt into private destinations, and hiding the second
    // behind the first is exactly the thing this section exists to prevent.
    const allowPart = hostAllowlist.length
      ? `host allowlist: ${plural(hostAllowlist.length, 'host')} over the always-on floor`
      : 'safeFetch floor: resolved-IP checks, per-hop redirect revalidation';
    const suffix = joinParts([
      net?.deny?.length ? plural(net.deny.length, 'deny rule') : '',
      boundary ? plural(boundary.networkTools.length, 'network tool') : '',
      thirdPartyCode && boundary?.networkTools.length === 0 ? 'reach is MCP/plugin-side only' : '',
    ]);
    netRow = net?.allow_private_urls
      ? {
          status: 'relaxed',
          detail: joinParts([
            'allow_private_urls — RFC1918/loopback/link-local permitted (cloud metadata still blocked)',
            allowPart,
            suffix,
          ]),
        }
      : {
          status: hostAllowlist.length ? 'narrowed' : 'enforced',
          detail: joinParts([allowPart, suffix]),
        };
  }

  // G-INJ — there is no opt-out. The knobs below narrow or relax behaviour
  // INSIDE the pipeline; wrapping and the tier-1 classifier run regardless.
  const inj = safety?.injectionDefense;
  const injRelaxations = [
    inj?.postReadDowngrade?.enabled === false ? 'post-read downgrade off' : '',
    inj?.blockSecretResults === false ? 'secret-bearing results emitted, not blocked' : '',
    inj?.toolResultDelimiters === false ? 'result delimiters off' : '',
  ].filter((p) => p !== '');
  const injTightenings = [
    inj?.classifier?.alwaysCallLLM ? 'LLM classifier on every untrusted result' : '',
    inj?.postReadDowngrade?.turns !== undefined
      ? `downgrade ${plural(inj.postReadDowngrade.turns, 'turn')}`
      : '',
    Array.isArray(inj?.postReadDowngrade?.tools)
      ? `downgrade set: ${plural(inj.postReadDowngrade.tools.length, 'tool')}`
      : '',
  ].filter((p) => p !== '');
  let injRow: GuaranteeRow;
  if (injRelaxations.length > 0) {
    injRow = {
      status: 'relaxed',
      detail: `${joinParts(injRelaxations)} — prelude, wrapping and classifier still run (no opt-out)`,
    };
  } else if (injTightenings.length > 0) {
    injRow = { status: 'narrowed', detail: joinParts(injTightenings) };
  } else {
    injRow = {
      status: 'enforced',
      detail: 'prelude, provenance wrap, 2-tier classify, post-read downgrade; no opt-out',
    };
  }

  // G-RED — redaction runs on the observability write path unconditionally.
  // The personality's observability policy changes WHAT is written, which is
  // the honest thing to show next to it.
  // `storeToolBodies` is reserved: nothing stores a tool result body (the
  // tool_call span closes with `result_size_bytes` only — `processTools` in
  // packages/core/src/agent-loop/stages/tool-processing.ts, pinned by
  // packages/core/src/__tests__/tool-body-not-stored.test.ts), so it is named
  // but never counted as a change to what is written.
  const obs = safety?.observability;
  const obsParts = [
    obs?.storeToolArgs ? `tool args ${obs.storeToolArgs}` : '',
    obs?.storeLlmPayloads ? `LLM payloads ${obs.storeLlmPayloads}` : '',
    obs?.redactPatterns?.length ? `+${plural(obs.redactPatterns.length, 'pattern')}` : '',
  ].filter((p) => p !== '');
  const storesFull = obs?.storeToolArgs === 'full' || obs?.storeLlmPayloads === 'full';
  const red: GuaranteeRow = {
    status: obsParts.length === 0 ? 'enforced' : storesFull ? 'relaxed' : 'narrowed',
    detail: joinParts([
      'known credential shapes redacted before observability.db',
      obsParts.join(', '),
      obs?.storeToolBodies
        ? `storeToolBodies ${obs.storeToolBodies} is reserved (tool results are never stored)`
        : '',
    ]),
  };

  // G-APP — approvalMode is the largest per-personality change available, and
  // `off` is the one an operator most needs to see at a glance.
  const mode = safety?.approvalMode ?? 'manual';
  const denyCount = safety?.denyRules?.length ?? 0;
  const denyPart = denyCount > 0 ? `${plural(denyCount, 'deny rule')} bind first` : '';
  let appRow: GuaranteeRow;
  if (mode === 'off') {
    appRow = {
      status: 'relaxed',
      detail: joinParts([
        'approvalMode off — flagged calls auto-fire; hardline floor still applies',
        denyPart,
      ]),
    };
  } else if (mode === 'smart') {
    appRow = {
      status: 'relaxed',
      detail: joinParts([
        'approvalMode smart — a reviewer model auto-approves flagged calls (fail-closed to ask)',
        denyPart,
      ]),
    };
  } else {
    appRow = {
      status: 'enforced',
      detail: joinParts(['approvalMode manual — flagged calls held for approval', denyPart]),
    };
  }

  // G-EXEC — an honesty guarantee. The posture IS the answer; a surface that
  // did not resolve one says so rather than guessing.
  let execRow: GuaranteeRow;
  if (!execution) {
    execRow = { status: 'enforced', detail: 'no execution posture resolved on this surface' };
  } else if (execution.posture.backend === 'none') {
    execRow = {
      status: 'n/a',
      detail:
        execution.posture.requirement === 'none'
          ? 'posture none — this personality declares execution: none'
          : 'posture none — no exec-bearing tool in this toolset',
    };
  } else {
    execRow = {
      status: 'enforced',
      detail: joinParts([
        `posture ${postureLabelFor(execution.posture)}`,
        `network ${execution.posture.networkMode}`,
        // A refused posture still NAMES a transport, so the row must say the
        // transport is not reached — otherwise "posture ssh (remote host)"
        // reads as a machine the agent is running on.
        execution.posture.sshRefused
          ? `remote requirement unmet (${execution.posture.sshRefused.reason}) — exec tools unavailable`
          : '',
        execution.posture.hostFallback
          ? `host fallback: ${execution.posture.hostFallback.reason}`
          : '',
        execution.posture.dockerAbsent ? 'Docker required but not running (A1)' : '',
      ]),
    };
  }

  return {
    'G-TOOLS': tools,
    'G-CAP': cap,
    'G-FS': fs,
    'G-NET': netRow,
    'G-INJ': injRow,
    'G-SEC': {
      status: 'enforced',
      detail: 'SecretsResolver is the only credential path; config carries refs, never values',
    },
    'G-RED': red,
    'G-APP': appRow,
    'G-EXEC': execRow,
    'G-WATCH': {
      status: 'enforced',
      detail: 'out-of-band cross-turn observer; no personality field narrows it',
    },
    'G-CHAN': {
      status: 'n/a',
      detail:
        'set by channel config, not by this personality — an unconfigured platform is ungated',
    },
    'G-AUDIT': {
      status: 'enforced',
      detail: 'safety decisions land in observability.db; no tamper-evidence',
    },
  };
}

/**
 * Render the `## Boundary` block — which published guarantees are enforced,
 * narrowed, relaxed, or inapplicable for THIS personality.
 *
 * A table rather than bullets: twelve rows read as a scan for the `relaxed`
 * ones, which is the operator's actual question, and the status column stays
 * aligned in a terminal as well as in the Web tab's Markdown.
 */
function boundarySection(rows: Record<GuaranteeId, GuaranteeRow>): string[] {
  const width = Math.max(...GUARANTEE_IDS.map((id) => id.length));
  return [
    '## Boundary',
    'Register status for this personality (the twelve published guarantees).',
    'enforced = kernel-enforced, unchanged here · narrowed = this personality tightens it ·',
    'relaxed = widens or disables something above the non-overridable floor · n/a = nothing here reaches it.',
    '',
    '| Guarantee | Status | For this personality |',
    '|---|---|---|',
    ...GUARANTEE_IDS.map((id) => {
      const row = rows[id];
      return `| ${id.padEnd(width)} | ${row.status.padEnd(8)} | ${row.detail} |`;
    }),
  ];
}

/**
 * What each known renderer name means in prose, so the sheet says more than an
 * opaque `echarts@1`. A renderer with no entry prints its bare spec string —
 * the declaration is honest either way, and a surface that maps no renderer of
 * that name simply renders the fence as a code block.
 */
const RENDERER_NOTE: Record<string, string> = {
  echarts: 'interactive charts — via charts skill',
};

/** `echarts@1` → `echarts@1 (interactive charts — via charts skill)`. */
function renderSpecLabel(spec: string): string {
  const note = RENDERER_NOTE[spec.split('@')[0] ?? ''];
  return note ? `${spec} (${note})` : spec;
}

/**
 * Render the `## Voice` block from `PersonalityConfig.voice` — the sanctioned
 * schema amendment made visible. Each unset knob prints what it inherits, so a
 * reader never has to guess whether a blank means "unset" or "missing".
 *
 * `Call look` prints the DERIVED treatment when unset rather than `(default)`,
 * because there is no default to name: an undeclared personality still draws a
 * specific shape, and the sheet's job is to say which one. It cannot see the
 * operator's `display.call_style`, so the derived value is stated as what it
 * is — the floor, which a pinned `display.call_style` overrides.
 */
function voiceSection(
  voice: NonNullable<PersonalityConfig['voice']>,
  personalityId: string,
): string[] {
  const lines: string[] = ['## Voice'];
  lines.push(`- TTS provider: ${voice.tts_provider ?? '(default auxiliary.tts)'}`);
  lines.push(`- STT provider: ${voice.stt_provider ?? '(default auxiliary.asr)'}`);
  lines.push(
    `- Realtime provider: ${voice.realtime_provider ?? '(deployment voice.realtime.default)'}`,
  );
  lines.push(`- TTS voice: ${voice.tts_voice ?? '(global default)'}`);
  const languages = Object.entries(voice.languages ?? {});
  if (languages.length > 0) {
    lines.push('- By language:');
    for (const [tag, id] of languages.sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`    - ${tag}: ${id}`);
    }
  }
  lines.push(`- Tier: ${voice.tier ?? '(deployment default)'}`);
  lines.push(`- Fast-lane model: ${voice.model ?? '(personality model)'}`);
  lines.push(
    `- Call look: ${voice.call_style ?? `${derivedCallTreatment(personalityId)} (derived from id)`}`,
  );
  return lines;
}

/**
 * Render a personality's character sheet as Markdown. Pure — takes the
 * loaded config and the SOUL.md body, returns the artifact. Optional
 * fields render as explicit `(none)` / `(engine default)` states so a
 * reader never has to guess whether a blank means "unset" or "missing".
 *
 * `renderers` is the skill-declared output capability (`ethos.renders`), as
 * PLAIN DATA — computed by callers via `SkillsInjector.resolveRenderers()`,
 * the SAME derivation the surfaces gate on, so the sheet cannot claim a
 * capability the renderer path would refuse. Absent or empty → no line.
 *
 * `boundary` sharpens the `## Boundary` section's applicability verdicts; the
 * section renders without it, it just never says "not applicable" for a
 * guarantee it cannot see the reach of.
 *
 * `routing` is the EFFECTIVE model — see {@link CharacterSheetRouting}. Absent
 * → `## Routing` prints the declared model, unqualified, as it always did.
 *
 * `mcpExport` is the RESOLVED export slice — see {@link CharacterSheetMcpExport}.
 * Absent → `## MCP export` still states whether the personality is exported at
 * all, and says the slice was not resolved rather than inventing one.
 *
 * `decisions` is the RESOLVED decision-site context — see
 * {@link CharacterSheetDecisions}. `## Decisions` renders only when the
 * personality declares a `decisions` block; absent context → declared values.
 */
export function renderCharacterSheet(
  config: PersonalityConfig,
  soulMd: string,
  execution?: CharacterSheetExecution,
  modelFit?: CharacterSheetModelFit,
  scriptSurface?: CharacterSheetScriptSurface,
  renderers?: readonly string[],
  boundary?: CharacterSheetBoundary,
  routing?: CharacterSheetRouting,
  mcpExport?: CharacterSheetMcpExport,
  decisions?: CharacterSheetDecisions,
): string {
  const lines: string[] = [`# ${config.id} — ${config.name}`, ''];

  if (config.description) lines.push(config.description, '');

  const prose = firstParagraph(soulMd);
  if (prose) lines.push(prose, '');

  lines.push('## Routing');
  lines.push(...routingLines(config, routing));
  lines.push(`- Dreaming: ${config.dreaming?.enable ? 'on' : 'off'}`);
  lines.push('');

  // Voice — rendered only when the personality declares one. A personality
  // with no `voice` block inherits the deployment's voice, and a section that
  // said so on every sheet would be noise ("cards earn existence").
  if (config.voice) {
    lines.push(...voiceSection(config.voice, config.id));
    lines.push('');
  }

  // Decisions — same rule as Voice: a personality that declares no
  // `decisions` block runs every site `off`, and saying so on every sheet
  // would be noise (plan decision-provider-personality §4.5).
  if (config.decisions) {
    lines.push(...decisionsSection(config.decisions, decisions));
    lines.push('');
  }

  // Output capability, derived from the skill set rather than the personality
  // schema: a skill declaring `ethos.renders` both TEACHES the fence format and
  // UNLOCKS the renderer, so one declaration drives both. It joins the declared
  // capabilities rather than following them, so `(none)` still means "nothing
  // here" instead of sitting above a line that contradicts it.
  const capabilities = [...(config.capabilities ?? [])];
  if (renderers && renderers.length > 0) {
    capabilities.push(`Renders: ${renderers.map(renderSpecLabel).join(', ')}`);
  }
  lines.push('## Capabilities');
  lines.push(...bulletList(capabilities, '(none)'));
  lines.push('');

  lines.push('## Memory');
  lines.push(`- Memory scope: personality:${config.id}`);
  lines.push('');

  // P-D11 — every permission section below reads the same extraction the
  // permission diff classifies, so the sheet and the diff cannot disagree.
  const surface = permissionSurface(config, mcpExport);
  const toolset = surface.toolset.tools;
  lines.push(...toolsetLines(surface));
  // Lane G — the in-script tool surface (`toolset ∩ SCRIPT_SAFE`), shown only
  // when the personality can run scripts at all. The exclusion list mirrors
  // the categories in core's SCRIPT_SAFE policy (script-safe.ts).
  if (toolset.includes('run_code') && scriptSurface) {
    // An EMPTY surface gets its own sentence, because the exclusion list is the
    // reason the count is lower than the toolset, not the reason it is ZERO —
    // printing it there reads as "the policy ate all 20 tools". Reaching zero
    // with `run_code` declared means every OTHER allowed tool is either in an
    // excluded category or unavailable in this process: `scriptCallableFor`
    // (packages/core/src/script-safe.ts) gates on the toolset, so a missing
    // execution backend no longer empties the surface.
    if (scriptSurface.callable.length === 0) {
      lines.push(
        `- Script-callable (run_code): none of ${toolset.length} tools — the script-tool surface ` +
          'is empty. Every other allowed tool is either excluded (code, delegation, MCP, plugins, ' +
          'clarify, credential-bearing terminal/debug) or unavailable in this process.',
      );
    } else {
      lines.push(
        `- Script-callable (run_code): ${scriptSurface.callable.length} of ${toolset.length} tools ` +
          '(excluded: code, delegation, MCP, plugins, clarify, credential-bearing terminal/debug)',
      );
    }
  }
  lines.push('');

  // §2 — the assembled system-prompt weight, so prompt cost is visible per
  // personality. When the caller injects a computed model fit (Lane 6, D5),
  // the ACCURATE `measureStaticFloor()` number replaces the old name-count
  // estimate — serialized tool schemas included. Without it, fall back to the
  // chars/4 estimate over the components the sheet already has (injection
  // prelude + SOUL.md + toolset names), which does NOT include tool schemas
  // or memory, so it reads low — hence "~" and "Estimated".
  lines.push('## Prompt size');
  if (modelFit) {
    lines.push(
      `- System-prompt tokens: ~${modelFit.floor.tokens} (measured static floor — serialized tool schemas included)`,
    );
    const projectContext = modelFit.floor.projectContext;
    if (projectContext?.workdir !== undefined) {
      lines.push(
        `- Project context (AGENTS.md/CLAUDE.md in ${projectContext.workdir}): ~${projectContext.tokens} tokens, included above`,
      );
    } else if (projectContext) {
      lines.push(
        '- Project context (AGENTS.md/CLAUDE.md): depends on the working directory — no fs_reach workdir declared, not included above',
      );
    }
  } else {
    lines.push(`- Estimated system-prompt tokens: ~${estimateSystemPromptTokens(soulMd, toolset)}`);
  }
  lines.push('');

  lines.push(...mcpServersLines(surface));
  lines.push('');

  // Ethos as an MCP SERVER, directly under Ethos as an MCP client — the two
  // share the name and an operator reading one is owed the other. Unconditional
  // for the same reason the `Publishing:` line is: "not exported" is the answer
  // a reader most needs, so it does not earn its place by being interesting.
  lines.push(...mcpExportSection(surface));
  lines.push('');

  lines.push(...pluginsLines(surface));
  lines.push('');

  lines.push(...filesystemReachLines(surface));

  // O-D10 — the outbound-approval posture, directly under the filesystem reach
  // because publishing is channel reach the way `fs_reach` is disk reach, and
  // the operator's question about both is the same one. Unconditional: "not
  // gated" is the answer an ungated personality's reader most needs, so this
  // line does not earn its existence by being interesting.
  lines.push('');
  lines.push(publishingLine(surface));

  // §4.7 — the register's per-personality state, directly under the reach it
  // summarises and BEFORE the conditional sections, so adding a posture or a
  // model-fit verdict still only appends to the sheet.
  lines.push('');
  lines.push(...boundarySection(guaranteeRows(config, execution, scriptSurface, boundary)));

  const soul = parseLivingSoul(soulMd);
  const isLivingSoul = soul.expression !== '' || soul.learningLog.length > 0;
  if (isLivingSoul) {
    lines.push('');
    lines.push('## Living Soul');
    const coreLineCount = soul.core.split('\n').filter((l) => l.trim() !== '').length;
    lines.push(
      `- Core: immutable identity (${coreLineCount} line${coreLineCount === 1 ? '' : 's'})`,
    );
    lines.push('');
    lines.push('### Expression');
    lines.push(soul.expression.trim() === '' ? '(empty)' : soul.expression.trim());
    lines.push('');
    lines.push('### Learning Log');
    if (soul.learningLog.length === 0) {
      lines.push('- (no changes yet)');
    } else {
      for (const e of soul.learningLog) {
        lines.push(`- ${e.at} · ${e.revisionId} · ${e.summary}`);
      }
    }
  }

  if (execution) {
    lines.push('');
    lines.push(...executionSection(config, execution));
  }

  if (modelFit) {
    lines.push('');
    lines.push(...modelFitSection(modelFit));
  }

  return `${lines.join('\n')}\n`;
}
