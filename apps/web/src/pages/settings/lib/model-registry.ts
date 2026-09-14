// Pure helpers behind Settings → Models' registry sections
// (plan/phases/model-registry.md T2.3, T2.4, T2.7, T2.8, T2.12).
//
// Every decision a click makes — which radio is checked, whether Test is
// clickable, what a catalog pick fills in, how a referent reads — lives here so
// `__tests__/model-registry-lib.test.ts` can pin it without a DOM. The
// components under `components/model-*.tsx` only wire these to RPCs.

import type {
  ModelCredentialStatus,
  ModelReferent,
  ModelRegistryEntryView,
  ModelRegistryListResult,
  ModelRegistryTestAllResult,
  ModelRegistryTestResult,
  ModelRegistryUpsertRequest,
} from '@ethosagent/web-contracts';
import type { rpc } from '../../../rpc';

export const modelRegistryKeys = {
  all: () => ['modelRegistry'] as const,
  list: () => [...modelRegistryKeys.all(), 'list'] as const,
};

/** The same key onboarding and the Personalities page use — one cache entry. */
export const modelCatalogKey = () => ['models', 'catalog'] as const;
export type ModelCatalog = Awaited<ReturnType<typeof rpc.models.catalog>>;

/** D19's window. The handler enforces it; this is the button's copy of it. */
export const TEST_COOLDOWN_MS = 10_000;

/** The roles `setRole` binds. `default` is the Default radio (`setDefault`). */
export const BINDABLE_ROLES = ['trivial', 'deep', 'dreaming'] as const;
export type BindableRole = (typeof BINDABLE_ROLES)[number];

/** Every role a declaration may name, in the order the pickers list them. */
export const ROLE_NAMES = ['trivial', 'default', 'deep', 'dreaming'] as const;

export type StatusTone = 'ok' | 'err' | 'warn' | 'muted';

export interface StatusView {
  tone: StatusTone;
  text: string;
  /** Hover text, where the short form leaves something out. */
  title: string | null;
}

// ---------------------------------------------------------------------------
// Table cells
// ---------------------------------------------------------------------------

/** `200000` → `200K`, `1048576` → `1M`, `null` → `—`. */
export function formatContextWindow(tokens: number | null): string {
  if (tokens === null) return '—';
  if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(1))}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return String(tokens);
}

/** `$0.003 · $0.015`; `—` when neither side is known. */
export function formatCost(input: number | null, output: number | null): string {
  if (input === null && output === null) return '—';
  const money = (n: number | null) => (n === null ? '—' : `$${n}`);
  return `${money(input)} · ${money(output)}`;
}

export function credentialView(credential: ModelCredentialStatus): StatusView {
  switch (credential) {
    case 'set':
      return { tone: 'ok', text: '✓ set', title: null };
    case 'missing':
      return { tone: 'err', text: '✗ no key', title: null };
    case 'not_needed':
      return { tone: 'muted', text: 'not needed', title: null };
  }
}

/**
 * The alias the Default radio shows checked: `modelRegistry.default` when it
 * names a row in the table, else none. The server makes the first entry of an
 * empty registry the default (`ModelRegistryService.upsert`), so a non-empty
 * table normally always has one; a hand-edited file that names a missing alias
 * shows no checked radio AND the `unknown_default` problem, rather than a radio
 * that claims a default the file does not have.
 */
export function defaultRadioValue(
  list: Pick<ModelRegistryListResult, 'entries' | 'default'>,
): string | null {
  const alias = list.default;
  return alias !== null && list.entries.some((e) => e.alias === alias) ? alias : null;
}

/** What a row's last-test status (under its Test button) says. Never "bad key" for an unreachable probe. */
export function lastTestView(outcome: ModelRegistryTestResult | undefined): StatusView {
  if (!outcome) return { tone: 'muted', text: 'not tested', title: null };
  switch (outcome.state) {
    case 'ok':
      return { tone: 'ok', text: `✓ ${outcome.latencyMs} ms`, title: null };
    case 'rejected':
      return { tone: 'err', text: '✗ refused', title: outcome.error };
    case 'unreachable':
      return {
        tone: 'warn',
        text: `⚠ could not reach ${outcome.providerKey}`,
        title: outcome.error,
      };
    case 'unconfigured':
      return { tone: 'err', text: '✗ not tested', title: outcome.reason };
    case 'rate_limited':
      return {
        tone: 'muted',
        text: `try again in ${outcome.retryAfterSeconds}s`,
        title: null,
      };
  }
}

// ---------------------------------------------------------------------------
// Test button (T2.8)
// ---------------------------------------------------------------------------

export type TestSubject = { alias: string } | { providerKey: string; modelId: string };

/** The key the 10s window is kept under — the same split the handler makes. */
export function testSubjectKey(subject: TestSubject): string {
  return 'alias' in subject
    ? `alias:${subject.alias}`
    : `entry:${subject.providerKey}/${subject.modelId}`;
}

/** Whole seconds left in the window; 0 once it has passed. */
export function cooldownSeconds(testedAt: number | undefined, now: number): number {
  if (testedAt === undefined) return 0;
  return Math.max(0, Math.ceil((testedAt + TEST_COOLDOWN_MS - now) / 1000));
}

/**
 * When a `rate_limited` answer did reach the page (another tab, a stale
 * clock), back-date the local record so the countdown ends when the handler's
 * does.
 */
export function testedAtFor(outcome: ModelRegistryTestResult, now: number): number {
  if (outcome.state !== 'rate_limited') return now;
  return now - TEST_COOLDOWN_MS + outcome.retryAfterSeconds * 1000;
}

export interface TestButtonState {
  disabled: boolean;
  label: string;
  /** Tooltip — why it is disabled. Null when it is clickable. */
  reason: string | null;
}

export function testButtonState(input: {
  /** Null when no provider entry is chosen yet (the drawer). */
  credential: ModelCredentialStatus | null;
  providerKey: string;
  /** Provider and model id are both filled in. */
  ready: boolean;
  testedAt: number | undefined;
  now: number;
}): TestButtonState {
  if (!input.ready) {
    return {
      disabled: true,
      label: 'Test',
      reason: 'Choose a provider entry and a model id first.',
    };
  }
  if (input.credential === 'missing') {
    return {
      disabled: true,
      label: 'Test',
      reason: `${input.providerKey} has no API key. Add it with Edit on that provider.`,
    };
  }
  const left = cooldownSeconds(input.testedAt, input.now);
  if (left > 0) {
    return {
      disabled: true,
      label: `Test · ${left}s`,
      reason: `Tested moments ago. Available again in ${left}s.`,
    };
  }
  return { disabled: false, label: 'Test', reason: null };
}

/**
 * `testAll` probes one alias per provider entry; its outcome speaks for every
 * alias on that entry, so each of them gets it.
 */
export function testAllByAlias(
  result: ModelRegistryTestAllResult,
): Record<string, ModelRegistryTestResult> {
  const out: Record<string, ModelRegistryTestResult> = {};
  for (const row of result.results) {
    for (const alias of row.aliases) out[alias] = row.outcome;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Add/Edit drawer (T2.4)
// ---------------------------------------------------------------------------

export interface ModelDraft {
  alias: string;
  provider: string;
  modelId: string;
  label: string;
  contextWindow: number | null;
  costPer1kInput: number | null;
  costPer1kOutput: number | null;
}

export function emptyDraft(): ModelDraft {
  return {
    alias: '',
    provider: '',
    modelId: '',
    label: '',
    contextWindow: null,
    costPer1kInput: null,
    costPer1kOutput: null,
  };
}

export function draftFromEntry(entry: ModelRegistryEntryView): ModelDraft {
  return {
    alias: entry.alias,
    provider: entry.providerKey,
    modelId: entry.modelId,
    label: entry.label ?? '',
    contextWindow: entry.contextWindow,
    costPer1kInput: entry.costPer1kInput,
    costPer1kOutput: entry.costPer1kOutput,
  };
}

/** Provider and model id filled — enough to Test. */
export function draftTestable(draft: ModelDraft): boolean {
  return draft.provider.trim() !== '' && draft.modelId.trim() !== '';
}

/** Alias too — enough to Save. Everything else is the server's to refuse. */
export function draftSavable(draft: ModelDraft): boolean {
  return draft.alias.trim() !== '' && draftTestable(draft);
}

/**
 * The `upsert` input. The model id is sent as typed (trimmed) whether or not
 * the catalog lists it — a local Ollama tag is a legitimate id (D9). Optional
 * fields are omitted when empty, which on `update` clears them.
 */
export function upsertRequest(
  draft: ModelDraft,
  mode: ModelRegistryUpsertRequest['mode'],
): ModelRegistryUpsertRequest {
  const label = draft.label.trim();
  return {
    mode,
    alias: draft.alias.trim(),
    provider: draft.provider.trim(),
    modelId: draft.modelId.trim(),
    ...(label ? { label } : {}),
    ...(draft.contextWindow !== null ? { contextWindow: draft.contextWindow } : {}),
    ...(draft.costPer1kInput !== null ? { costPer1kInput: draft.costPer1kInput } : {}),
    ...(draft.costPer1kOutput !== null ? { costPer1kOutput: draft.costPer1kOutput } : {}),
  };
}

/** The provider TYPE (`anthropic`, `ollama`, …) behind a provider entry key. */
export function providerTypeOf(
  list: Pick<ModelRegistryListResult, 'providerEntries'> | undefined,
  providerKey: string,
): string | null {
  return list?.providerEntries.find((e) => e.key === providerKey)?.provider ?? null;
}

export interface CatalogSuggestion {
  value: string;
  label: string;
  contextWindow: number;
}

/** The catalog's models for one provider type — suggestions, never a limit. */
export function catalogSuggestions(
  catalog: ModelCatalog | undefined,
  providerType: string | null,
): CatalogSuggestion[] {
  if (!catalog || providerType === null) return [];
  return (catalog.providers[providerType]?.models ?? []).map((m) => ({
    value: m.id,
    label: m.label,
    contextWindow: m.contextWindow,
  }));
}

/**
 * A catalog pick fills the model id and the context window. The catalog
 * carries no pricing (`ModelCatalogOutput`), so cost stays whatever the
 * operator typed. Every field remains editable afterwards.
 */
export function pickCatalogModel(draft: ModelDraft, suggestion: CatalogSuggestion): ModelDraft {
  return { ...draft, modelId: suggestion.value, contextWindow: suggestion.contextWindow };
}

// ---------------------------------------------------------------------------
// Referents (T2.12)
// ---------------------------------------------------------------------------

export interface ReferentParts {
  before: string;
  /** The literal to set in mono; null when the referent has none. */
  name: string | null;
  after: string;
}

export function referentParts(referent: ModelReferent): ReferentParts {
  switch (referent.kind) {
    case 'personality': {
      const slot = referent.field === 'model' ? '' : ` (${referent.field})`;
      const builtin = referent.readOnly ? ', built-in and read-only' : '';
      return { before: 'personality ', name: referent.personalityId, after: slot + builtin };
    }
    case 'role':
      return { before: 'role ', name: referent.role, after: '' };
    case 'default':
      return { before: 'the default model', name: null, after: '' };
    case 'routing':
      return { before: 'routing for ', name: referent.personalityId, after: '' };
    case 'fallback':
      return { before: 'fallback of ', name: referent.alias, after: '' };
  }
}

export function referentText(referent: ModelReferent): string {
  const parts = referentParts(referent);
  return `${parts.before}${parts.name ?? ''}${parts.after}`;
}

/** Stable React key — a referent has no id of its own. */
export function referentKey(referent: ModelReferent): string {
  return JSON.stringify(referent);
}

/** Aliases a removal may repoint to: every other entry. */
export function repointChoices(
  list: Pick<ModelRegistryListResult, 'entries' | 'default'>,
  alias: string,
): string[] {
  const others = list.entries.map((e) => e.alias).filter((a) => a !== alias);
  // The default first, when it is a choice — it is the likeliest target.
  const def = list.default;
  if (def !== null && others.includes(def)) return [def, ...others.filter((a) => a !== def)];
  return others;
}

// ---------------------------------------------------------------------------
// Roles and routing (T2.3, T2.7)
// ---------------------------------------------------------------------------

export function unboundLabel(list: Pick<ModelRegistryListResult, 'entries' | 'default'>): string {
  const def = defaultRadioValue(list);
  return def !== null ? `Unbound, uses ${def}` : 'Unbound, no default set';
}

/** What a role runs on right now: its binding, else the default. */
export function resolvedRole(
  list: Pick<ModelRegistryListResult, 'entries' | 'default' | 'roles'>,
  role: (typeof ROLE_NAMES)[number],
): string | null {
  if (role === 'default') return list.roles.default ?? defaultRadioValue(list);
  return list.roles[role] ?? defaultRadioValue(list);
}

export interface RoutingRow {
  personalityId: string;
  declaration: string;
}

export function routingRows(routing: Record<string, string>): RoutingRow[] {
  return Object.entries(routing)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([personalityId, declaration]) => ({ personalityId, declaration }));
}

export interface DeclarationOption {
  value: string;
  /** The role or alias, set in mono. */
  name: string;
  /** What it resolves to (a role) or its label (an alias). */
  hint: string;
}

export interface DeclarationGroup {
  label: 'Roles' | 'Models';
  options: DeclarationOption[];
}

/**
 * What a routing row may name: the four roles, then every alias in the
 * registry — and nothing else. The alias list IS the registry's entries, in
 * config-file order; there is no free-text path to a vendor id here.
 */
export function declarationGroups(
  list: Pick<ModelRegistryListResult, 'entries' | 'default' | 'roles'>,
): DeclarationGroup[] {
  return [
    {
      label: 'Roles',
      options: ROLE_NAMES.map((role) => {
        const target = resolvedRole(list, role);
        const bound = role === 'default' ? true : list.roles[role] !== null;
        return {
          value: role,
          name: role,
          hint: target === null ? 'no default set' : bound ? target : `unbound, uses ${target}`,
        };
      }),
    },
    {
      label: 'Models',
      options: list.entries.map((e) => ({
        value: e.alias,
        name: e.alias,
        hint: e.label ?? e.modelId,
      })),
    },
  ];
}

/** `deep → opus` for a role, the alias itself for an alias. */
export function declarationLabel(
  list: Pick<ModelRegistryListResult, 'entries' | 'default' | 'roles'>,
  declaration: string,
): string {
  const role = ROLE_NAMES.find((r) => r === declaration);
  if (role === undefined) return declaration;
  const target = resolvedRole(list, role);
  return target === null ? role : `${role} → ${target}`;
}

/** Personalities a routing row may pick: not already routed, except its own. */
export function routablePersonalityIds(
  allIds: readonly string[],
  routing: Record<string, string>,
  own: string | null,
): string[] {
  return allIds.filter((id) => id === own || !(id in routing));
}
