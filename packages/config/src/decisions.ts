// The operator's decision-provider keys (plan/phases/decision-provider-jev.md
// §7, D7, D12, R6, R9): `decisions.*` in ~/.ethos/config.yaml.
//
// Two shapes, on purpose. `DecisionsConfig` is what the file SAYS — explicit
// keys only, no defaults filled in — so `serializeDecisionsLines` writes back
// exactly the lines the operator wrote and a config save never pins
// `decisions.model: jev-latest` into a file that relied on the default.
// `resolveDecisionsConfig` is what the runtime RUNS: defaults applied, each
// site's per-call budget chosen, and each site's EFFECTIVE mode decided under
// R6. Consumers (wiring, `ethos doctor`) read the resolved form.
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
  /** `decisions.sites.<site>`. Unset = `off`. */
  sites?: Partial<Record<DecisionSiteId, DecisionSiteMode>>;
  /** `decisions.thresholds.*`, each a number in [0, 1]. */
  thresholds?: {
    injection?: number;
    approver?: { approve?: number; deny?: number };
    router?: number;
  };
}

export interface ResolvedDecisionSite {
  /** What `decisions.sites.<site>` asked for (`off` when unset). */
  requested: DecisionSiteMode;
  /** What runs: `requested`, except `on` with a missing threshold runs `shadow` (R6). */
  effective: DecisionSiteMode;
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
  sites: Record<DecisionSiteId, ResolvedDecisionSite>;
  thresholds: NonNullable<DecisionsConfig['thresholds']>;
}

/** The threshold keys a site needs before `on` may run as `on` (plan §7 table). */
function missingThresholdKeys(d: DecisionsConfig, site: DecisionSiteId): string[] {
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
 * One site's requested and effective mode. R6: `on` whose threshold key(s)
 * are absent resolves to `shadow` — Jev runs and is observed, today's verdict
 * is used — so no unmeasured verdict is ever acted on (D12), and boot goes on.
 */
export function resolveDecisionSiteMode(
  d: DecisionsConfig,
  site: DecisionSiteId,
): Pick<ResolvedDecisionSite, 'requested' | 'effective' | 'missingThresholds'> {
  const requested = d.sites?.[site] ?? 'off';
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
  const site = (id: DecisionSiteId): ResolvedDecisionSite => ({
    ...resolveDecisionSiteMode(d, id),
    timeoutMs: d.timeouts?.[id] ?? DECISION_SITE_DEFAULT_TIMEOUT_MS[id],
  });
  const sites = {
    injection: site('injection'),
    approver: site('approver'),
    router: site('router'),
  };
  return {
    provider: d.provider,
    model: d.model ?? DECISIONS_DEFAULT_MODEL,
    baseUrl: d.baseUrl ?? DECISIONS_DEFAULT_BASE_URL,
    timeoutMs: d.timeoutMs ?? DECISIONS_DEFAULT_TIMEOUT_MS,
    sites,
    thresholds: d.thresholds ?? {},
  };
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
    const m = kv[`sites.${site}`];
    if (m !== undefined) {
      if (isOneOf(DECISION_SITE_MODES, m)) d.sites = { ...d.sites, [site]: m };
      else drop(`sites.${site}`, m, `one of ${DECISION_SITE_MODES.join(', ')}`);
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

  // R6 — load-time enforcement of D12, pinned by
  // packages/config/src/__tests__/config-decisions.test.ts.
  for (const site of DECISION_SITES) {
    const { effective, requested, missingThresholds } = resolveDecisionSiteMode(d, site);
    if (requested === 'on' && effective !== 'on') {
      warnings.push(
        `decisions.sites.${site}: ${describeDecisionSiteDowngrade(missingThresholds)}. ` +
          "Jev runs and is observed; today's verdict is used until the threshold is set.",
      );
    }
  }
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
  for (const site of DECISION_SITES) {
    const m = d.sites?.[site];
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
