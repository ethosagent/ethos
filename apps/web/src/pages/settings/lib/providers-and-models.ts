// Pure helpers behind Settings → Models › providers & models: one list, grouped
// by provider in chain order, with each provider's models beneath it
// (the approved "Providers & models" mockup, frames 1–3).
//
// Every decision a click makes — which group a model lands in, what the
// Fallback model Select offers, which alias a new model is previewed under,
// what "Add all to models" will write — lives here so
// `__tests__/settings-provider-rows.test.ts` can pin it without a DOM. The
// components only wire these to `modelRegistry.*` RPCs.

import type {
  ModelProviderEntryView,
  ModelRegistryAddProviderRequest,
  ModelRegistryChainModel,
  ModelRegistryEntryView,
  ModelRegistryListResult,
} from '@ethosagent/web-contracts';
import {
  getCatalogEntry,
  PROVIDER_CATALOG,
  type ProviderCatalogEntry,
} from '../../../onboarding/catalog/providers';
import { type ModelCatalog, ROLE_NAMES, type StatusView } from './model-registry';

export type ChainModelView = ModelRegistryChainModel;

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

export interface ProviderGroup {
  entry: ModelProviderEntryView;
  /** 0 = Primary, N = Fallback N. */
  position: number;
  /** Registry models whose `provider` is this entry, in config-file order. */
  models: ModelRegistryEntryView[];
  /** Chain models on this entry that the registry does not hold yet. */
  pending: ChainModelView[];
}

export interface ProviderGroups {
  groups: ProviderGroup[];
  /** Registry models naming a provider key no entry has. Never hidden. */
  orphans: ModelRegistryEntryView[];
}

export function providerGroups(
  list: Pick<ModelRegistryListResult, 'entries' | 'providerEntries' | 'chainModels'>,
): ProviderGroups {
  const ordered = [...list.providerEntries].sort((a, b) => a.index - b.index);
  const keys = new Set(ordered.map((e) => e.key));
  return {
    groups: ordered.map((entry, position) => ({
      entry,
      position,
      models: list.entries.filter((m) => m.providerKey === entry.key),
      // Matched on chain position: a chain model's `providerKey` is the
      // derived name when the entry has no id, and the position is what both
      // views agree on.
      pending: list.chainModels.filter((c) => c.index === entry.index),
    })),
    orphans: list.entries.filter((m) => !keys.has(m.providerKey)),
  };
}

export function orderLabel(position: number): string {
  return position === 0 ? 'Primary' : `Fallback ${position}`;
}

// ---------------------------------------------------------------------------
// Provider header
// ---------------------------------------------------------------------------

/**
 * A provider type Settings can add that the onboarding catalog does not list.
 *
 * Kept OUT of `PROVIDER_CATALOG` (apps/web/src/onboarding/catalog/providers.ts)
 * on purpose. Onboarding's AuthStep prompts every entry that is not device-auth
 * or keyless for an API key and has no API version field, its `authType` union
 * has no AWS-credential member, and `bedrock` is not a `ProviderId`
 * (packages/web-contracts/src/schemas.ts) — the catalog test that every
 * `wiresAs` parses as one would fail. So azure and bedrock are Settings-only.
 */
export interface SettingsOnlyProviderType
  extends Omit<ProviderCatalogEntry, 'id' | 'authType' | 'wiresAs' | 'recommended'> {
  id: 'azure' | 'bedrock';
  wiresAs: 'azure' | 'bedrock';
  /** `aws-credentials`: no API key — `bedrockFactory` (extensions/llm-bedrock)
   *  signs from static keys in the secret store or the AWS credential chain. */
  authType: 'api-key' | 'aws-credentials';
  /** `onboarding.validateProvider` cannot test what this type saves (`connectFields`). */
  untestable: true;
}

export type SettingsProviderType = ProviderCatalogEntry | SettingsOnlyProviderType;

/** What the Add provider Type list offers: the onboarding catalog, then azure and bedrock. */
export const SETTINGS_PROVIDER_TYPES: readonly SettingsProviderType[] = [
  ...PROVIDER_CATALOG,
  {
    id: 'azure',
    label: 'Azure OpenAI',
    description:
      'OpenAI models on your Azure resource. The base URL is the resource endpoint, and a model id is a deployment name.',
    authType: 'api-key',
    signupUrl: 'https://portal.azure.com',
    // `azureFactory` (extensions/llm-azure) refuses an entry without one.
    baseUrl: { required: true },
    wiresAs: 'azure',
    untestable: true,
  },
  {
    id: 'bedrock',
    label: 'AWS Bedrock',
    description:
      'Claude and other models through your AWS account, signed with AWS credentials (IAM role, SSO, or a profile). No API key.',
    authType: 'aws-credentials',
    signupUrl: 'https://console.aws.amazon.com/bedrock',
    wiresAs: 'bedrock',
    untestable: true,
  },
];

/** The Settings provider type with this id. */
export function settingsProviderType(id: SettingsProviderType['id']): SettingsProviderType {
  return SETTINGS_PROVIDER_TYPES.find((p) => p.id === id) ?? getCatalogEntry('anthropic');
}

/** The provider type entry for a provider TYPE — by id first, then by what it wires as. */
export function catalogEntryFor(providerType: string): SettingsProviderType | null {
  return (
    SETTINGS_PROVIDER_TYPES.find((p) => p.id === providerType) ??
    SETTINGS_PROVIDER_TYPES.find((p) => p.wiresAs === providerType) ??
    null
  );
}

/** The credential / auth half of a provider header. */
export function providerAuthView(entry: Pick<ModelProviderEntryView, 'provider' | 'credential'>) {
  const view = (tone: StatusView['tone'], text: string): StatusView => ({
    tone,
    text,
    title: null,
  });
  switch (entry.credential) {
    case 'set':
      return view('ok', '✓ key set');
    case 'missing':
      return view('err', '✗ no key');
    case 'not_needed': {
      const authType = catalogEntryFor(entry.provider)?.authType;
      if (authType === 'device-auth') return view('muted', 'device auth, no key');
      if (authType === 'aws-credentials') return view('muted', 'AWS credentials, no key');
      return view('muted', 'no key needed');
    }
  }
}

/** The page-session test-log key a provider's Test connection is kept under. */
export function providerTestKey(providerKey: string): string {
  return `provider:${providerKey}`;
}

export interface FallbackModelChoice {
  /** The alias the Select shows; null when none is set or none matches. */
  alias: string | null;
  /** `providers.N.model` when it names no model under this provider. */
  unmatched: string | null;
}

/**
 * What the Fallback model Select shows. `providers.N.model` holds a MODEL ID,
 * so it is matched against this provider's own registry models — the Select is
 * closed over those, and a stored id none of them carries is surfaced rather
 * than silently shown as blank.
 */
export function fallbackModelChoice(group: Pick<ProviderGroup, 'entry' | 'models'>) {
  const stored = group.entry.model;
  if (stored === null || stored === '') return { alias: null, unmatched: null };
  const hit = group.models.find((m) => m.modelId === stored);
  return hit ? { alias: hit.alias, unmatched: null } : { alias: null, unmatched: stored };
}

/** `sonnet` · `claude-sonnet-5` · `200K` · `$0.003 · $0.015 / 1K` — empty parts dropped. */
export function modelSubParts(
  model: Pick<
    ModelRegistryEntryView,
    'modelId' | 'label' | 'contextWindow' | 'costPer1kInput' | 'costPer1kOutput'
  >,
  format: {
    context: (n: number | null) => string;
    cost: (i: number | null, o: number | null) => string;
  },
): string[] {
  const parts: string[] = [];
  if (model.contextWindow !== null) parts.push(format.context(model.contextWindow));
  const cost = format.cost(model.costPer1kInput, model.costPer1kOutput);
  if (cost !== '—') parts.push(`${cost} / 1K`);
  if (model.label) parts.push(model.label);
  return parts;
}

// ---------------------------------------------------------------------------
// "Add all to models" (frame 2)
// ---------------------------------------------------------------------------

export function unadoptedBannerText(count: number): { lead: string; rest: string } {
  return count === 1
    ? {
        lead: "1 model in your provider chain isn't in models yet.",
        rest: 'Turns already run on it; adding it lets personalities and roles choose it.',
      }
    : {
        lead: `${count} models in your provider chain aren't in models yet.`,
        rest: 'Turns already run on them; adding them lets personalities and roles choose them.',
      };
}

export interface ImportLine {
  alias: string;
  providerKey: string;
  modelId: string;
  /** The `providers.N.id` line the import writes, for an entry with no explicit id. */
  writesId: string | null;
}

export function importLines(chain: readonly ChainModelView[]): ImportLine[] {
  return chain.map((c) => ({
    alias: c.suggestedAlias,
    providerKey: c.providerKey,
    modelId: c.modelId,
    writesId: c.idIsExplicit ? null : `providers.${c.index}.id: ${c.providerKey}`,
  }));
}

// ---------------------------------------------------------------------------
// Add provider drawer (frame 3)
// ---------------------------------------------------------------------------

/** Role names are not aliases (`reserved_alias`), so a preview never proposes one. */
const RESERVED_ALIASES: ReadonlySet<string> = new Set(ROLE_NAMES);

/**
 * The alias a model id is previewed under: lower-case, a trailing `-YYYYMMDD`
 * snapshot date dropped, every run of other characters one hyphen —
 * `claude-haiku-4-5-20251001` → `claude-haiku-4-5`, `gpt-5.6-terra` →
 * `gpt-5-6-terra`. A preview only: the operator edits it before saving, and the
 * server's `validateModelRegistry` is what accepts or refuses it.
 */
export function aliasFromModelId(modelId: string): string {
  return modelId
    .trim()
    .toLowerCase()
    .replace(/-\d{8}$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** `base`, else `base-<providerKey>`, else `base-<providerKey>-2`, … */
export function uniqueAlias(base: string, providerKey: string, taken: ReadonlySet<string>): string {
  const free = (a: string) => a !== '' && !taken.has(a) && !RESERVED_ALIASES.has(a);
  if (free(base)) return base;
  const withKey = base === '' ? providerKey : `${base}-${providerKey}`;
  if (free(withKey)) return withKey;
  let n = 2;
  while (!free(`${withKey}-${n}`)) n += 1;
  return `${withKey}-${n}`;
}

/**
 * The alias each chosen model id will be saved under, in order: an alias the
 * operator typed wins; otherwise the slug, with `-<providerKey>` appended when
 * an existing alias — or one chosen earlier in this same list — has it.
 */
export function previewAliases(
  modelIds: readonly string[],
  providerKey: string,
  existingAliases: readonly string[],
  typed: Readonly<Record<string, string>>,
): Record<string, string> {
  const taken = new Set(existingAliases);
  const out: Record<string, string> = {};
  for (const id of modelIds) {
    const own = typed[id]?.trim();
    const alias = own ? own : uniqueAlias(aliasFromModelId(id), providerKey, taken);
    out[id] = alias;
    taken.add(alias);
  }
  return out;
}

/** A provider id not already in the chain: `anthropic`, else `anthropic-2`, … */
export function uniqueProviderId(base: string, takenKeys: readonly string[]): string {
  const taken = new Set(takenKeys);
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

export interface ConnectFields {
  apiKey: boolean;
  baseUrl: 'required' | 'optional' | null;
  deviceAuth: boolean;
  /** Whether `onboarding.validateProvider` can test this type before it is saved. */
  testable: boolean;
}

/** Only the fields the provider's `authType` needs. */
export function connectFields(entry: SettingsProviderType): ConnectFields {
  const baseUrl = entry.baseUrl ? (entry.baseUrl.required ? 'required' : 'optional') : null;
  switch (entry.authType) {
    case 'api-key':
      // Azure is not testable before it is saved: `validateProvider` takes no
      // `apiVersion`, so a pass would not have tested the version being saved.
      return { apiKey: true, baseUrl, deviceAuth: false, testable: !('untestable' in entry) };
    case 'aws-credentials':
      // Bedrock reads no key and no base URL — `region` / `awsProfile`
      // (`providerExtraFields`) — and `validateProvider` has no bedrock path.
      return { apiKey: false, baseUrl: null, deviceAuth: false, testable: false };
    case 'self-hosted':
      return { apiKey: false, baseUrl: baseUrl ?? 'optional', deviceAuth: false, testable: true };
    case 'device-auth':
      // Device sign-in stores a token, not a key: `validateProvider` has
      // nothing to send, so it is tested with Test connection once added.
      return { apiKey: false, baseUrl: null, deviceAuth: true, testable: false };
  }
}

export type ProviderExtraField = 'apiVersion' | 'region' | 'awsProfile';

export interface ProviderExtraFieldSpec {
  field: ProviderExtraField;
  label: string;
  placeholder: string;
  hint: string;
}

/**
 * The provider-entry lines only some provider TYPES read — `ProviderEntry` in
 * packages/config/src/index.ts: azure reads `apiVersion` (default
 * `AZURE_DEFAULT_API_VERSION`, extensions/llm-azure), bedrock reads `region`
 * (default `us-east-1`) and `awsProfile` (extensions/llm-bedrock). Every
 * other type ignores them. A Map, so a type named like an Object.prototype
 * key finds nothing.
 */
const EXTRA_FIELDS: ReadonlyMap<string, readonly ProviderExtraFieldSpec[]> = new Map([
  [
    'azure',
    [
      {
        field: 'apiVersion',
        label: 'API version',
        placeholder: '2024-12-01-preview',
        hint: 'Azure REST API version. Empty uses 2024-12-01-preview.',
      },
    ],
  ],
  [
    'bedrock',
    [
      {
        field: 'region',
        label: 'Region',
        placeholder: 'us-east-1',
        hint: 'AWS region for the Bedrock endpoint. Empty uses us-east-1.',
      },
      {
        field: 'awsProfile',
        label: 'AWS profile',
        placeholder: 'a profile from ~/.aws/config',
        hint: 'Used when no static AWS keys are set, e.g. after aws sso login.',
      },
    ],
  ],
]);

/** The type-specific fields a provider of this TYPE takes, in display order. */
export function providerExtraFields(providerType: string): readonly ProviderExtraFieldSpec[] {
  return EXTRA_FIELDS.get(providerType) ?? [];
}

/** The non-blank values of this type's own extra fields — never another type's. */
export function extraFieldValues(
  providerType: string,
  extras: Partial<Record<ProviderExtraField, string>> | undefined,
): Partial<Record<ProviderExtraField, string>> {
  const out: Partial<Record<ProviderExtraField, string>> = {};
  for (const { field } of providerExtraFields(providerType)) {
    const value = extras?.[field]?.trim();
    if (value) out[field] = value;
  }
  return out;
}

/** The toast after a successful `modelRegistry.addProvider`. */
export function addedProviderMessage(result: {
  providerKey: string;
  models: readonly { alias: string }[];
}): string {
  const n = result.models.length;
  if (n === 0) return `Added provider ${result.providerKey}. Add models to it below.`;
  const aliases = result.models.map((m) => m.alias).join(', ');
  return `Added provider ${result.providerKey} with ${n} model${n === 1 ? '' : 's'}: ${aliases}.`;
}

export interface ConnectDraft {
  catalogId: SettingsProviderType['id'];
  id: string;
  apiKey: string;
  baseUrl: string;
  /** The type's `providerExtraFields`, as typed; blank ones are not sent. */
  extras?: Partial<Record<ProviderExtraField, string>>;
}

/** Why step 1 cannot continue yet; null when it can. */
export function connectBlocker(
  draft: ConnectDraft,
  fields: ConnectFields,
  takenKeys: readonly string[],
): string | null {
  const id = draft.id.trim();
  if (id === '') return 'Give the provider an id.';
  if (takenKeys.includes(id)) return `A provider named ${id} already exists.`;
  if (fields.apiKey && draft.apiKey.trim() === '') return 'Paste the API key.';
  if (fields.baseUrl === 'required' && draft.baseUrl.trim() === '') return 'Enter the base URL.';
  return null;
}

export interface CatalogPick {
  modelId: string;
  label: string;
  contextWindow: number | null;
}

/** The catalog's models for a provider type — by catalog id, then by what it wires as. */
export function catalogPicks(
  catalog: ModelCatalog | undefined,
  entry: SettingsProviderType,
): CatalogPick[] {
  const models =
    catalog?.providers[entry.id]?.models ?? catalog?.providers[entry.wiresAs]?.models ?? [];
  return models.map((m) => ({ modelId: m.id, label: m.label, contextWindow: m.contextWindow }));
}

/**
 * The ONE `addProvider` call "Add provider and N models" makes: the provider
 * TYPE it wires as, its id, only the credential fields its auth type uses, and
 * every chosen model with its previewed alias.
 */
export function addProviderRequest(input: {
  entry: SettingsProviderType;
  fields: ConnectFields;
  draft: ConnectDraft;
  models: readonly Pick<CatalogPick, 'modelId' | 'contextWindow'>[];
  aliases: Readonly<Record<string, string>>;
}): ModelRegistryAddProviderRequest {
  const apiKey = input.draft.apiKey.trim();
  const baseUrl = input.draft.baseUrl.trim();
  return {
    provider: input.entry.wiresAs,
    id: input.draft.id.trim(),
    ...(input.fields.apiKey && apiKey !== '' ? { apiKey } : {}),
    ...(input.fields.baseUrl !== null && baseUrl !== '' ? { baseUrl } : {}),
    ...extraFieldValues(input.entry.wiresAs, input.draft.extras),
    models: input.models.map((m) => {
      const alias = input.aliases[m.modelId];
      return {
        modelId: m.modelId,
        ...(alias ? { alias } : {}),
        ...(m.contextWindow !== null ? { contextWindow: m.contextWindow } : {}),
      };
    }),
  };
}

/** Split "a, b c" into ids, dropping blanks and ones already listed. */
export function parseModelIds(input: string, already: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of input.split(/[\s,]+/)) {
    const id = raw.trim();
    if (id !== '' && !already.includes(id) && !out.includes(id)) out.push(id);
  }
  return out;
}
