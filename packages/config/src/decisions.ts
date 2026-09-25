// The operator's decision-provider keys (plan/phases/decision-provider-jev.md
// §7, D7, D12, R6, R9): `decisions.*` in ~/.ethos/config.yaml.
//
// Two shapes, on purpose. `DecisionsConfig` is what the file SAYS — explicit
// keys only, no defaults filled in — so `serializeDecisionsLines` writes back
// exactly the lines the operator wrote and a config save never pins
// `decisions.model: jev-latest` into a file that relied on the default.
// `resolveDecisionsConfig` is what the runtime RUNS: defaults applied and each
// site's per-call budget chosen. Consumers (wiring, `ethos doctor`) read the
// resolved form.
//
// Site ENABLEMENT is not here (plan/phases/decision-provider-personality.md
// §3, §6, PD5): which sites run, and in which mode, is declared per
// personality (`PersonalityConfig.decisions`) and decided per call by
// `resolvePersonalityDecisionSite` below — the one resolver wiring, doctor and
// web-api share. A global `decisions.sites.<site>` line is claimed, warned
// about and kept verbatim on write (`legacySites`), and never read.
//
// Nothing here throws. A bad value is dropped with a warning, the posture of
// `retentionDuration` in ./index: a decisions line must never stop the gateway
// from booting, because the worst a dropped value can do is leave a site on
// today's path (plan R6).

/** The one provider value accepted until a second provider lands (plan §7). */
export const DECISION_PROVIDERS = ['typesafe'] as const;
export type DecisionProviderName = (typeof DECISION_PROVIDERS)[number];

/** Site ids (plan §7). */
export const DECISION_SITES = ['injection', 'approver', 'router'] as const;
export type DecisionSiteId = (typeof DECISION_SITES)[number];

/** `off` = today's path; `shadow` = both run, today's verdict used; `on` = Jev's verdict used. */
export const DECISION_SITE_MODES = ['off', 'shadow', 'on'] as const;
export type DecisionSiteMode = (typeof DECISION_SITE_MODES)[number];

export const DECISIONS_DEFAULT_MODEL = 'jev-latest';
export const DECISIONS_DEFAULT_BASE_URL = 'https://api.typesafe.ai';
export const DECISIONS_DEFAULT_TIMEOUT_MS = 2000;
/** Built-in per-site budgets (R9): the router is on the time-to-first-token path. */
export const DECISION_SITE_DEFAULT_TIMEOUT_MS: Readonly<Record<DecisionSiteId, number>> = {
  injection: 2000,
  approver: 2000,
  router: 500,
};

/** The vault ref the API key is read from (plan §7). */
export const DECISIONS_API_KEY_REF = 'providers/typesafe/apiKey';

/** `decisions.*` as written in config.yaml — explicit keys only. */
export interface DecisionsConfig {
  /** Present ⇔ a decision layer exists. Absent or invalid → the field is absent. */
  provider: DecisionProviderName;
  /** `decisions.model`. Unset = `jev-latest`. */
  model?: string;
  /** `decisions.baseUrl`, an http(s) URL. Unset = `https://api.typesafe.ai`. */
  baseUrl?: string;
  /** `decisions.timeoutMs`, positive integer ms. Unset = 2000. */
  timeoutMs?: number;
  /** `decisions.timeouts.<site>`, positive integer ms. */
  timeouts?: Partial<Record<DecisionSiteId, number>>;
  /**
   * `decisions.sites.<site>` lines as written, value verbatim. NOT READ by any
   * resolver: sites are enabled per personality (plan
   * decision-provider-personality §6, PD5). Kept only so `serializeDecisionsLines`
   * writes the operator's line back and the load warning keeps naming it until
   * it is moved. Remove one minor after 0.8.0.
   */
  legacySites?: Partial<Record<DecisionSiteId, string>>;
  /** `decisions.thresholds.*`, each a number in [0, 1]. */
  thresholds?: {
    injection?: number;
    approver?: { approve?: number; deny?: number };
    router?: number;
  };
}

/**
 * Why a personality's site resolved to less than it asked for — or, for
 * `undeclared`, why it is `off` at all. Absent when the site runs exactly as
 * requested (including an explicit `off`).
 *
 * - `undeclared` — the personality sets no mode for this site.
 * - `no-provider` — the personality sets a mode but no `decisions.provider` (PD10).
 * - `not-configured` — the personality names a provider the operator has not
 *   configured (no global `decisions.provider`, or a different one) (PD3).
 * - `threshold-missing` — `on` requested, running `shadow` (R6).
 *
 * `no-key` and `inert-approval-mode` are annotations added by the surfaces
 * that know them (doctor, character sheet), not runtime gates (plan §4.4).
 */
export type PersonalityDecisionSiteReason =
  | 'undeclared'
  | 'no-provider'
  | 'not-configured'
  | 'threshold-missing';

export interface ResolvedDecisionSite {
  /** What the personality's `decisions.sites.<site>` asked for (`off` when unset). */
  requested: DecisionSiteMode;
  /** What runs. See {@link resolvePersonalityDecisionSite}. */
  effective: DecisionSiteMode;
  reason?: PersonalityDecisionSiteReason;
  /** Full key names of the threshold keys whose absence caused the R6 downgrade. */
  missingThresholds: string[];
  /** This site's per-call budget, ms (R9). */
  timeoutMs: number;
}

export interface ResolvedDecisionsConfig {
  provider: DecisionProviderName;
  model: string;
  baseUrl: string;
  /**
   * `decisions.timeoutMs`. Per R9 this is the breaker's yardstick: a `timeout`
   * counts toward the breaker only when that call's budget was ≥ this value.
   */
  timeoutMs: number;
  /** Each site's per-call budget, ms (R9). */
  timeouts: Record<DecisionSiteId, number>;
  thresholds: NonNullable<DecisionsConfig['thresholds']>;
}

/** The threshold keys a site needs before `on` may run as `on` (plan §7 table). */
export function missingThresholdKeys(
  d: Pick<DecisionsConfig, 'thresholds'>,
  site: DecisionSiteId,
): string[] {
  const t = d.thresholds;
  if (site === 'approver') {
    const missing: string[] = [];
    if (t?.approver?.approve === undefined) missing.push('decisions.thresholds.approver.approve');
    if (t?.approver?.deny === undefined) missing.push('decisions.thresholds.approver.deny');
    return missing;
  }
  return t?.[site] === undefined ? [`decisions.thresholds.${site}`] : [];
}

/**
 * One site's effective mode for a `requested` mode. R6: `on` whose threshold
 * key(s) are absent resolves to `shadow` — Jev runs and is observed, today's
 * verdict is used — so no unmeasured verdict is ever acted on (D12).
 */
export function resolveDecisionSiteMode(
  d: Pick<DecisionsConfig, 'thresholds'>,
  site: DecisionSiteId,
  requested: DecisionSiteMode,
): Pick<ResolvedDecisionSite, 'requested' | 'effective' | 'missingThresholds'> {
  if (requested !== 'on') return { requested, effective: requested, missingThresholds: [] };
  const missingThresholds = missingThresholdKeys(d, site);
  return {
    requested,
    effective: missingThresholds.length > 0 ? 'shadow' : 'on',
    missingThresholds,
  };
}

/**
 * Defaults applied. Budget precedence per site (R9): an explicit
 * `decisions.timeouts.<site>` wins; otherwise the built-in per-site default
 * (`DECISION_SITE_DEFAULT_TIMEOUT_MS`). `decisions.timeoutMs` does NOT move a
 * site's budget — every site has a built-in default, so "the default for any
 * site without its own" (plan §7) never applies to one of today's three; it is
 * kept as the breaker's yardstick (`ResolvedDecisionsConfig.timeoutMs`).
 */
export function resolveDecisionsConfig(d: DecisionsConfig): ResolvedDecisionsConfig {
  const budget = (id: DecisionSiteId): number =>
    d.timeouts?.[id] ?? DECISION_SITE_DEFAULT_TIMEOUT_MS[id];
  return {
    provider: d.provider,
    model: d.model ?? DECISIONS_DEFAULT_MODEL,
    baseUrl: d.baseUrl ?? DECISIONS_DEFAULT_BASE_URL,
    timeoutMs: d.timeoutMs ?? DECISIONS_DEFAULT_TIMEOUT_MS,
    timeouts: {
      injection: budget('injection'),
      approver: budget('approver'),
      router: budget('router'),
    },
    thresholds: d.thresholds ?? {},
  };
}

/** The part of `PersonalityConfig.decisions` the resolver reads (structurally the same type). */
export interface PersonalityDecisionsInput {
  provider?: string;
  sites?: Partial<Record<DecisionSiteId, DecisionSiteMode>>;
}

/**
 * THE decision-site resolver (plan decision-provider-personality §4.4): what
 * one site runs for one personality. Pure. A site runs (`shadow` / `on`) only
 * when BOTH halves say so:
 *
 * 1. the personality requests it — `decisions.sites.<site>` is `shadow` or
 *    `on` (unset → `off`, reason `undeclared`);
 * 2. the personality names a provider — `decisions.provider` (absent → `off`,
 *    reason `no-provider`, PD10);
 * 3. the operator configured THAT provider — `global.provider` equals it
 *    (otherwise → `off`, reason `not-configured`, PD3: never a refused turn);
 * 4. R6: `on` without its global threshold key(s) → `shadow`, reason
 *    `threshold-missing`.
 *
 * A missing key is NOT decided here: the provider handle returns no provider
 * and `runDecisionSite` takes today's path (packages/wiring/src/decision-provider.ts).
 * Every caller — wiring's three sites, doctor, web-api — goes through this
 * one function. Pinned by `__tests__/config-decisions.test.ts`.
 */
export function resolvePersonalityDecisionSite(
  personalityDecisions: PersonalityDecisionsInput | undefined,
  site: DecisionSiteId,
  global: ResolvedDecisionsConfig | undefined,
): ResolvedDecisionSite {
  const timeoutMs = global?.timeouts[site] ?? DECISION_SITE_DEFAULT_TIMEOUT_MS[site];
  const raw = personalityDecisions?.sites?.[site];
  // A mode outside the union (a hand-built object; the personality parser
  // already drops one) reads as undeclared, never as a running site.
  const declared = raw !== undefined && isOneOf(DECISION_SITE_MODES, raw) ? raw : undefined;
  const requested: DecisionSiteMode = declared ?? 'off';
  const off = (reason?: PersonalityDecisionSiteReason): ResolvedDecisionSite => ({
    requested,
    effective: 'off',
    ...(reason ? { reason } : {}),
    missingThresholds: [],
    timeoutMs,
  });
  if (requested === 'off') return off(declared === undefined ? 'undeclared' : undefined);
  const provider = personalityDecisions?.provider?.trim();
  if (!provider) return off('no-provider');
  if (!global || global.provider !== provider) return off('not-configured');
  const r = resolveDecisionSiteMode(global, site, requested);
  return {
    ...r,
    ...(r.effective !== r.requested ? { reason: 'threshold-missing' as const } : {}),
    timeoutMs,
  };
}

/**
 * Whether a personality gets the `decide` tool (plan decision-tool D6): it
 * picked a decision model (`decisions.provider` in its config.yaml) AND the
 * operator configured THAT provider (global `decisions.provider` equals it) —
 * the same two halves `resolvePersonalityDecisionSite` reads for `no-provider`
 * / `not-configured`. No site mode and no toolset line is needed. Pure. Every
 * caller goes through it: the loop's per-personality exclusion
 * (`personalityToolExclude` in packages/wiring/src/build-agent-loop.ts) and
 * the character sheet's `configured` flag (`resolveCharacterSheetDecisions`,
 * packages/wiring/src/decision-diagnostics.ts). Pinned by
 * `__tests__/config-decisions.test.ts`.
 */
export function decisionToolEnabled(
  personalityDecisions: Pick<PersonalityDecisionsInput, 'provider'> | undefined,
  global: Pick<ResolvedDecisionsConfig, 'provider'> | undefined,
): boolean {
  const provider = personalityDecisions?.provider?.trim();
  return !!provider && global?.provider === provider;
}

/**
 * The R6 operator sentence, shared by the config warning and `ethos doctor`
 * so the two can never word it differently.
 */
export function describeDecisionSiteDowngrade(missingThresholds: readonly string[]): string {
  return `\`on\` requested, running \`shadow\`: ${missingThresholds.map((k) => `\`${k}\``).join(', ')} missing`;
}

/** Matches one `decisions.*` line the codec models; field path in group 1, value in 2. */
export const DECISIONS_LINE_RE =
  /^decisions\.(provider|model|baseUrl|timeoutMs|timeouts\.(?:injection|approver|router)|sites\.(?:injection|approver|router)|thresholds\.(?:injection|router|approver\.approve|approver\.deny)):\s*(.+)$/;

/**
 * The PD5 load warning for one global `decisions.sites.<site>` line. Shared by
 * the config warning and (N4) `ethos doctor`.
 */
export function describeLegacyDecisionSite(site: DecisionSiteId, value: string): string {
  return (
    `decisions.sites.${site}: ${value} is no longer read — decision sites are enabled per ` +
    'personality. Move it to ~/.ethos/personalities/<id>/config.yaml as ' +
    `"decisions.provider: typesafe" and "decisions.sites.${site}: ${value}".`
  );
}

function positiveInt(raw: string): number | undefined {
  if (raw.trim() === '') return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

function unitInterval(raw: string): number | undefined {
  // `Number('')` is 0 — an empty value is a typo, not a threshold of 0.
  if (raw.trim() === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : undefined;
}

function httpUrl(raw: string): string | undefined {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' || u.protocol === 'http:' ? raw : undefined;
  } catch {
    return undefined;
  }
}

function isOneOf<T extends string>(values: readonly T[], value: string): value is T {
  return (values as readonly string[]).includes(value);
}

/**
 * Build `DecisionsConfig` from the claimed `decisions.*` lines (field path →
 * value). Returns `undefined` — no decision layer — when `decisions.provider`
 * is absent or not `typesafe`. Every dropped value and every R6 downgrade is
 * pushed onto `warnings`, which `parseConfigYaml` files under the non-fatal
 * notices `ethos doctor` and the boot banners print.
 */
export function buildDecisionsConfig(
  kv: Record<string, string>,
  warnings: string[],
): DecisionsConfig | undefined {
  // PD5 — a global site line is claimed (so it is not dumped to passthrough),
  // warned about, and never read. Warned whether or not a provider is set:
  // either way it no longer does anything.
  let legacySites: DecisionsConfig['legacySites'];
  for (const site of DECISION_SITES) {
    const m = kv[`sites.${site}`];
    if (m === undefined) continue;
    warnings.push(describeLegacyDecisionSite(site, m));
    legacySites = { ...legacySites, [site]: m };
  }
  const providerRaw = kv.provider;
  if (providerRaw === undefined) return undefined;
  if (!isOneOf(DECISION_PROVIDERS, providerRaw)) {
    warnings.push(
      `decisions.provider: "${providerRaw}" is not a decision provider (expected ` +
        `${DECISION_PROVIDERS.join(', ')}). Ignoring it; no decision layer runs.`,
    );
    return undefined;
  }
  const d: DecisionsConfig = { provider: providerRaw };
  if (legacySites) d.legacySites = legacySites;
  const drop = (key: string, raw: string, expected: string) =>
    warnings.push(
      `decisions.${key}: "${raw}" is not ${expected}. Ignoring it; the default applies.`,
    );

  if (kv.model !== undefined) {
    if (kv.model.trim() !== '') d.model = kv.model;
    else drop('model', kv.model, 'a model id');
  }
  if (kv.baseUrl !== undefined) {
    const url = httpUrl(kv.baseUrl);
    if (url) d.baseUrl = url;
    else drop('baseUrl', kv.baseUrl, 'an http(s) URL');
  }
  if (kv.timeoutMs !== undefined) {
    const n = positiveInt(kv.timeoutMs);
    if (n !== undefined) d.timeoutMs = n;
    else drop('timeoutMs', kv.timeoutMs, 'a positive integer');
  }
  for (const site of DECISION_SITES) {
    const t = kv[`timeouts.${site}`];
    if (t !== undefined) {
      const n = positiveInt(t);
      if (n !== undefined) d.timeouts = { ...d.timeouts, [site]: n };
      else drop(`timeouts.${site}`, t, 'a positive integer');
    }
  }
  const threshold = (key: string): number | undefined => {
    const raw = kv[`thresholds.${key}`];
    if (raw === undefined) return undefined;
    const n = unitInterval(raw);
    if (n === undefined) drop(`thresholds.${key}`, raw, 'a number in [0, 1]');
    return n;
  };
  const injection = threshold('injection');
  const router = threshold('router');
  const approve = threshold('approver.approve');
  const deny = threshold('approver.deny');
  if (injection !== undefined) d.thresholds = { ...d.thresholds, injection };
  if (router !== undefined) d.thresholds = { ...d.thresholds, router };
  if (approve !== undefined || deny !== undefined) {
    d.thresholds = {
      ...d.thresholds,
      approver: {
        ...(approve !== undefined ? { approve } : {}),
        ...(deny !== undefined ? { deny } : {}),
      },
    };
  }
  // R6 is no longer a load-time warning: it depends on which personality asks
  // for `on`, so `ethos doctor` reports it per personality (plan §6, §8).
  return d;
}

/** `DecisionsConfig` → config.yaml lines (unrendered), explicit keys only. */
export function serializeDecisionsLines(d: DecisionsConfig): string[] {
  const lines = [`decisions.provider: ${d.provider}`];
  if (d.model !== undefined) lines.push(`decisions.model: ${d.model}`);
  if (d.baseUrl !== undefined) lines.push(`decisions.baseUrl: ${d.baseUrl}`);
  if (d.timeoutMs !== undefined) lines.push(`decisions.timeoutMs: ${d.timeoutMs}`);
  for (const site of DECISION_SITES) {
    const t = d.timeouts?.[site];
    if (t !== undefined) lines.push(`decisions.timeouts.${site}: ${t}`);
  }
  // PD5 — written back verbatim so a config save never deletes a line the
  // operator wrote; the load warning keeps naming it until it is moved.
  for (const site of DECISION_SITES) {
    const m = d.legacySites?.[site];
    if (m !== undefined) lines.push(`decisions.sites.${site}: ${m}`);
  }
  const t = d.thresholds;
  if (t?.injection !== undefined) lines.push(`decisions.thresholds.injection: ${t.injection}`);
  if (t?.approver?.approve !== undefined)
    lines.push(`decisions.thresholds.approver.approve: ${t.approver.approve}`);
  if (t?.approver?.deny !== undefined)
    lines.push(`decisions.thresholds.approver.deny: ${t.approver.deny}`);
  if (t?.router !== undefined) lines.push(`decisions.thresholds.router: ${t.router}`);
  return lines;
}
