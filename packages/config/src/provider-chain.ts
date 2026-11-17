import { createHash } from 'node:crypto';
import { nearestConfigKey } from './known-keys';
import { parseConfigScalar } from './scalar';

/** A provider-chain entry as `parseConfigYaml` returns it. `apiKey` is `''`
 *  when the file carries none (Bedrock on an AWS profile, a local server). */
export interface ProviderConfig extends ProviderChainEntry {
  apiKey: string;
}

// ---------------------------------------------------------------------------
// Provider chain codec — `providers.<n>.<field>: <value>`
// ---------------------------------------------------------------------------

/**
 * One `providers.<n>` entry exactly as config.yaml holds it: values verbatim,
 * so an `apiKey` is normally a `${secrets:…}` reference and nothing here
 * resolves it.
 */
export interface ProviderChainEntry {
  provider: string;
  /**
   * Stable operator-chosen key for THIS entry, independent of its position in
   * the chain (D2/D24 of plan/phases/model-registry.md).
   *
   * It exists because a `modelRegistry.<alias>.provider` names a provider
   * ENTRY, not a provider TYPE: two entries can both be `anthropic` — two
   * accounts, two keys — and a registry that named only the type could not say
   * which credential to bill. `deriveProviderKey` synthesizes a key for an
   * entry that carries none, but that synthesized key is POSITIONAL and is for
   * display only; a registry alias may reference only an entry with an
   * explicit `id:` here (D24, enforced by `validateModelRegistry` in T1.3,
   * which does not exist yet).
   */
  id?: string;
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  /** Azure-only: REST API version (e.g. `2024-10-21`). Required when
   *  `provider === 'azure'`; ignored otherwise. */
  apiVersion?: string;
  /** Bedrock-only: AWS region for the Bedrock runtime endpoint (e.g.
   *  `us-west-2`). Defaults to `us-east-1`; ignored otherwise. */
  region?: string;
  /** Bedrock-only: named AWS profile from `~/.aws/config` (e.g. an SSO profile
   *  after `aws sso login`), used when no static keys are configured; ignored
   *  otherwise. Named `awsProfile`, not `profile`, because `profile` already
   *  means a per-model `ModelProfile` (`models.*`) in this config. */
  awsProfile?: string;
  /**
   * Azure-only (V-CP-5 / UBP-038): which output-cap parameter requests to this
   * entry's deployment send. Absent → the model-id rule on the deployment name
   * (`outputCapParam` in extensions/llm-openai-compat/src/transport.ts), which
   * sends `max_tokens` to a reasoning deployment whose name is not a reasoning
   * model id — and Azure refuses it. `max_completion_tokens` forces the
   * reasoning spelling for such a deployment. Read by `azureFactory`
   * (extensions/llm-azure); any other value is refused at parse with a notice.
   */
  outputCapParam?: 'max_tokens' | 'max_completion_tokens';
  /**
   * Whether this entry is a failover hop for the default rung. Absent means
   * `true` — every entry that ever existed was one (D23b).
   *
   * `failover: false` makes an entry a CREDENTIAL that is not a chain hop: it
   * is still in the provider map, still referenceable by a registry alias,
   * still probed and testable, and still shown in Settings → Models — but it is
   * not in the `ChainedProvider` the default rung rides, so adding a model for
   * one vision or compression slot cannot silently give every unpinned turn a
   * failover hop to that vendor. Nothing reads this field yet: chain membership
   * is `createLLMFromRegistry` / `buildProviderMap` in `packages/wiring`
   * (T1.20), and this task is the codec only.
   */
  failover?: boolean;
  /**
   * openclaw-9.5-adoption item 7 (D32) — let the provider compact the
   * conversation server-side instead of the local context engine. Absent
   * means off. Honoured only on a `provider: anthropic` entry (wiring,
   * `createLLMFromRegistry`, warns and ignores it anywhere else).
   */
  serverCompaction?: boolean;
  /**
   * The input-token count at which the server compacts. Absent → the local
   * compaction gate's own threshold for this model (`pressureGateTokens` in
   * packages/core), so turning the switch on does not move WHEN compaction
   * happens. A positive integer. Anthropic's API documentation puts the
   * minimum at 50,000; a lower value is raised to it, not rejected
   * (`SERVER_COMPACTION_MIN_TRIGGER_TOKENS`, extensions/llm-anthropic).
   */
  serverCompactionTriggerTokens?: number;
  /**
   * Every other `providers.<n>.<field>` line, keyed by `<field>`. It belongs to
   * THIS entry: `renderProviderChain` re-emits it under whatever index the
   * entry has at write time, so it moves with the entry on reorder and is gone
   * with it on delete (pinned by `__tests__/config-provider-chain.test.ts` and
   * apps/web-api's `config.repository.test.ts`). Nothing at runtime reads it;
   * it exists so a writer that does not model a field cannot delete it.
   */
  passthrough?: Record<string, string>;
}

/**
 * The modelled fields, in render order. These are the fields `createLLM`
 * (packages/wiring/src/index.ts) forwards to a chain entry's provider factory,
 * plus the two that describe the entry itself rather than its transport — `id`
 * (who this entry is, D2/D24) and `failover` (whether it is a chain hop, D23b).
 * Any other field lands in `passthrough`.
 *
 * `id` renders directly after `provider` because the pair names the entry, and
 * `failover` last because it qualifies the whole entry. A config that carried
 * either as an unmodelled passthrough field before this landed reads back as a
 * modelled one and renders in this order instead of the sorted passthrough
 * tail — one line moves, nothing is duplicated (`renderProviderChain` never
 * emits a passthrough field that shadows a modelled one) and no migration is
 * needed. Pinned by `__tests__/config-model-registry.test.ts`.
 */
const PROVIDER_CHAIN_FIELDS = [
  'provider',
  'id',
  'apiKey',
  'model',
  'baseUrl',
  'apiVersion',
  'region',
  'awsProfile',
  'outputCapParam',
  'failover',
  'serverCompaction',
  'serverCompactionTriggerTokens',
] as const;
type ProviderChainField = (typeof PROVIDER_CHAIN_FIELDS)[number];
/** The modelled fields whose value is NOT a free string — the booleans
 *  `failover` and `serverCompaction`, the integer
 *  `serverCompactionTriggerTokens` and the two-value `outputCapParam`, which
 *  parse and render handle by hand. */
const PROVIDER_CHAIN_TYPED_FIELDS = [
  'outputCapParam',
  'failover',
  'serverCompaction',
  'serverCompactionTriggerTokens',
] as const;
type ProviderChainStringField = Exclude<
  ProviderChainField,
  (typeof PROVIDER_CHAIN_TYPED_FIELDS)[number]
>;

const PROVIDER_CHAIN_STRING_FIELDS: readonly ProviderChainStringField[] =
  PROVIDER_CHAIN_FIELDS.filter(
    (f): f is ProviderChainStringField =>
      !(PROVIDER_CHAIN_TYPED_FIELDS as readonly string[]).includes(f),
  );

function isProviderChainField(field: string): field is ProviderChainField {
  return (PROVIDER_CHAIN_FIELDS as readonly string[]).includes(field);
}

function isProviderChainStringField(field: string): field is ProviderChainStringField {
  return (PROVIDER_CHAIN_STRING_FIELDS as readonly string[]).includes(field);
}

/** A `<field>` both writers can interpolate into a key unquoted: no space, no
 *  colon, nothing a line parser could split on. */
const PROVIDER_CHAIN_FIELD = /^[A-Za-z0-9_.-]+$/;

/** `providers.<n>.<field>: <value>`, `<field>` in the `PROVIDER_CHAIN_FIELD`
 *  charset. Space before the colon is tolerated (hand edits). */
const PROVIDER_CHAIN_LINE = /^providers\.(\d+)\.([A-Za-z0-9_.-]+)\s*:\s*(.*)$/;

/** Never a computed own-key on a parsed slot — see RESERVED_TOOL_SETTINGS_KEYS. */
const RESERVED_PROVIDER_FIELDS = new Set(['__proto__', 'constructor', 'prototype']);

function isRenderableField(field: string): boolean {
  return PROVIDER_CHAIN_FIELD.test(field) && !RESERVED_PROVIDER_FIELDS.has(field);
}

/**
 * True for a line `parseProviderChain` reads — the `providers.<n>.<field>`
 * grammar. Line parsers skip these and hand the whole file to
 * `parseProviderChain`, so the namespace has one reader; `unexpressibleLines`
 * skips them so a stale line can never re-attach to whichever entry later
 * takes its index. A `providers.<n>.` line outside the grammar (a space inside
 * the field name) is NOT claimed and is handled like any other malformed line.
 */
export function isProviderChainLine(line: string): boolean {
  return PROVIDER_CHAIN_LINE.test(line);
}

/**
 * Parse every `providers.<n>.*` line into chain entries, ordered by index.
 *
 * Pure: no I/O, no secret resolution. Values go through `parseConfigScalar`,
 * so the CLI writer's spelling (`renderConfigScalar`) and apps/web-api's
 * ConfigRepository's (`quoteConfigScalar` on more values) read back the same
 * value. An index without a
 * `provider` names nothing the runtime can resolve and is dropped along with
 * its other fields, the same rule `buildVoiceProviderEntry` applies to the
 * voice rosters. Reserved object keys (`__proto__`, …) and empty values are
 * dropped.
 *
 * `notices` is the optional sink for what was dropped and why — a reserved
 * field name, and an index with no `provider` line, which loses the whole
 * entry. The codec is pure, so it cannot reach the config notice tables
 * itself: `parseConfigYaml` passes one and files them under
 * `parseWarningsByConfig` (boot deprecations, `configParseNotices`,
 * `ethos doctor`), and apps/web-api's `ConfigRepository.read` returns them on
 * `RawConfig.providerNotices`.
 */
export function parseProviderChain(
  lines: Iterable<string>,
  notices?: string[],
): ProviderChainEntry[] {
  const byIndex = new Map<number, Map<string, string>>();
  for (const line of lines) {
    const m = line.match(PROVIDER_CHAIN_LINE);
    const field = m?.[2];
    if (!m || !field) continue;
    if (!isRenderableField(field)) {
      notices?.push(
        `config.yaml: 'providers.${m[1]}.${field}' uses a reserved name and was ignored.`,
      );
      continue;
    }
    const value = parseConfigScalar(m[3] ?? '');
    if (!value) continue;
    const idx = Number(m[1]);
    const slot = byIndex.get(idx) ?? new Map<string, string>();
    byIndex.set(idx, slot);
    slot.set(field, value);
  }
  const entries: ProviderChainEntry[] = [];
  for (const idx of [...byIndex.keys()].sort((a, b) => a - b)) {
    const slot = byIndex.get(idx);
    const provider = slot?.get('provider');
    if (!slot || !provider) {
      // A typo'd `providers.1.provder:` loses the WHOLE entry, on every
      // surface, and this codec is the only reader — so it says which lines,
      // and which of them was probably meant as the `provider` line (U4).
      const fields = [...(slot?.keys() ?? [])];
      const typo = fields.find((f) => nearestConfigKey(f, ['provider']) === 'provider');
      notices?.push(
        `config.yaml: no 'providers.${idx}.provider' line, so entry ${idx} is ignored — ` +
          `${fields.map((f) => `'providers.${idx}.${f}'`).join(', ')} had no effect` +
          (typo
            ? `; did you mean 'providers.${idx}.provider' for 'providers.${idx}.${typo}'?`
            : '.'),
      );
      continue;
    }
    const entry: ProviderChainEntry = { provider };
    const passthrough: Record<string, string> = {};
    for (const [field, value] of slot) {
      if (field === 'provider') continue;
      if (field === 'failover') {
        // The namespace's only boolean, and absent means `true` (D23b) — so an
        // unreadable value is NOT silently taken as the default: it says so and
        // the line is gone on the next write, the same trade the reserved-name
        // drop above makes.
        if (value === 'true' || value === 'false') entry.failover = value === 'true';
        else {
          notices?.push(
            `config.yaml: 'providers.${idx}.failover' must be true or false, so '${value}' was ` +
              'ignored — this entry stays a failover hop.',
          );
        }
        continue;
      }
      if (field === 'serverCompaction') {
        // Absent means off, so an unreadable value is refused out loud rather
        // than read as either answer — the same trade `failover` makes.
        if (value === 'true' || value === 'false') entry.serverCompaction = value === 'true';
        else {
          notices?.push(
            `config.yaml: 'providers.${idx}.serverCompaction' must be true or false, so ` +
              `'${value}' was ignored — this entry compacts locally.`,
          );
        }
        continue;
      }
      if (field === 'outputCapParam') {
        if (value === 'max_tokens' || value === 'max_completion_tokens') {
          entry.outputCapParam = value;
        } else {
          notices?.push(
            `config.yaml: 'providers.${idx}.outputCapParam' must be max_tokens or ` +
              `max_completion_tokens, so '${value}' was ignored — the parameter follows the ` +
              'deployment name.',
          );
        }
        continue;
      }
      if (field === 'serverCompactionTriggerTokens') {
        const n = Number(value);
        if (/^\d+$/.test(value) && Number.isSafeInteger(n) && n > 0) {
          entry.serverCompactionTriggerTokens = n;
        } else {
          notices?.push(
            `config.yaml: 'providers.${idx}.serverCompactionTriggerTokens' must be a positive ` +
              `whole number of tokens, so '${value}' was ignored — the trigger defaults to the ` +
              'local compaction threshold.',
          );
        }
        continue;
      }
      if (isProviderChainStringField(field)) entry[field] = value;
      else {
        // Kept so a writer cannot delete it, but read by nothing at runtime
        // (see `ProviderChainEntry.passthrough`) — so it is said out loud (U4).
        passthrough[field] = value;
        const near = nearestConfigKey(field, PROVIDER_CHAIN_FIELDS);
        notices?.push(
          `config.yaml: 'providers.${idx}.${field}' is not a provider-chain field, so it has ` +
            `no effect${near ? `; did you mean 'providers.${idx}.${near}'?` : '.'}`,
        );
      }
    }
    if (Object.keys(passthrough).length > 0) entry.passthrough = passthrough;
    entries.push(entry);
  }
  return entries;
}

/**
 * Render chain entries as `[key, value]` pairs, index = array position:
 * modelled fields in `PROVIDER_CHAIN_FIELDS` order, then `passthrough` sorted
 * so the file is byte-stable. Empty values are omitted. Value encoding is the
 * caller's — each config writer applies its own scalar rule to the whole file.
 * A passthrough field that fails the line grammar, is reserved, or shadows a
 * modelled field is not rendered.
 *
 * `failover` is emitted whenever it is set, `true` included: the default is
 * absence, not `false`, so an operator who wrote the line out in full keeps it
 * rather than watching an unrelated save delete it.
 */
export function renderProviderChain(
  entries: readonly ProviderChainEntry[],
): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [i, entry] of entries.entries()) {
    for (const field of PROVIDER_CHAIN_FIELDS) {
      if (field === 'failover' || field === 'serverCompaction') {
        const flag = entry[field];
        if (flag !== undefined) out.push([`providers.${i}.${field}`, String(flag)]);
        continue;
      }
      if (field === 'serverCompactionTriggerTokens') {
        const n = entry.serverCompactionTriggerTokens;
        if (n !== undefined) out.push([`providers.${i}.${field}`, String(n)]);
        continue;
      }
      if (field === 'outputCapParam') {
        const param = entry.outputCapParam;
        if (param !== undefined) out.push([`providers.${i}.${field}`, param]);
        continue;
      }
      const value = entry[field];
      if (field === 'provider' || value) out.push([`providers.${i}.${field}`, value ?? '']);
    }
    const passthrough = entry.passthrough ?? {};
    for (const field of Object.keys(passthrough).sort()) {
      const value = passthrough[field];
      if (!value || isProviderChainField(field) || !isRenderableField(field)) continue;
      out.push([`providers.${i}.${field}`, value]);
    }
  }
  return out;
}

/**
 * A DISPLAY and DIAGNOSTIC name for one chain entry: its explicit `id` when it
 * has one, otherwise `<provider>` at index 0 and `<provider>-<n>` after it.
 *
 * **A registry alias must never reference a derived key (D24.)** The derived
 * half is positional: it renames when the chain is reordered or when
 * `providers.0` is deleted, and reordering the chain is the ordinary way an
 * operator changes failover priority. Under D6/D14 a renamed key dangles every
 * `modelRegistry.<alias>.provider` that pointed at it and refuses every
 * personality that named that alias — a routine edit becoming a fleet-wide
 * outage. So `modelRegistry.<alias>.provider` may name only an entry carrying
 * an explicit `providers.<n>.id`, which is deterministic under reorder and
 * survives credential rotation in place. That refusal is `validateModelRegistry`
 * in `packages/config/src/model-registry.ts` (T1.3), which does not exist yet —
 * nothing enforces it at the time this function landed. Use this key to LABEL an
 * entry in a listing, a doctor row or an error message, never to bind one.
 *
 * Two arguments, so "first entry of that type" is read as "index 0" rather than
 * as the first entry with this `provider` value — a lone `openai` at index 3
 * is `openai-3`, not `openai`. That is a deliberate narrowing of D2's wording:
 * the un-narrowed rule is not computable from `(entry, index)`, and carrying
 * the index in the name is the more honest spelling for a key D24 has already
 * demoted to positional.
 */
export function deriveProviderKey(entry: ProviderChainEntry, index: number): string {
  if (entry.id) return entry.id;
  return index === 0 ? entry.provider : `${entry.provider}-${index}`;
}

/**
 * `entry` with every modelled field it lacks taken from `top` — the top-level
 * `provider` / `apiKey` / `model` / … as a chain entry — when both name the
 * same provider; `entry` unchanged otherwise.
 *
 * The runtime reads the top-level fields while the chain has fewer than two
 * entries and the chain from two on (`createLLM`, packages/wiring). A chain
 * growing past one entry therefore takes the primary's place, and its entry 0
 * must carry the top-level key reference (the same vault entry, not a copy),
 * base URL, model and provider-specific fields — or the primary loses its key
 * the moment a fallback is added. Used by apps/web-api's `ConfigService.update`
 * and `ethos fallback add`.
 *
 * `failover` is not inherited: it describes whether the ENTRY is a chain hop,
 * and the top-level spelling IS chain index 0 (D2), so it has no separate
 * chain membership to donate. `id` is in the loop like every other string
 * field, but neither caller's top-level entry carries one
 * (`topLevelChainEntry` in apps/web-api's config.service.ts, and the literal in
 * `ethos fallback add`), so in practice nothing is inherited there either.
 */
export function fillFromTopLevel<E extends ProviderChainEntry>(
  entry: E,
  top: ProviderChainEntry,
): E {
  if (entry.provider !== top.provider) return entry;
  const next: E = { ...entry };
  for (const field of PROVIDER_CHAIN_STRING_FIELDS) {
    const value = top[field];
    if (field !== 'provider' && !next[field] && value) (next as ProviderChainEntry)[field] = value;
  }
  return next;
}

/**
 * An opaque token for a chain's exact content — order, every modelled field,
 * key REFERENCES (not values) and `passthrough` — hashed over
 * `renderProviderChain`'s canonical pairs, so object key order does not move
 * it. apps/web-api's `config.get` returns it and `config.update` must send it
 * back with a `providers` list: a list built against a chain that has since
 * changed (another tab, `ethos fallback`) is refused instead of overlaid onto
 * the wrong entries (`ConfigService.update`, apps/web-api).
 */
export function providerChainVersion(entries: readonly ProviderChainEntry[]): string {
  return createHash('sha256')
    .update(JSON.stringify(renderProviderChain(entries)))
    .digest('hex')
    .slice(0, 16);
}
