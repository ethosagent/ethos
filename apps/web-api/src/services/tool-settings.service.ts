import { normalizeWebSearchRecency } from '@ethosagent/config';
import { resolveToolSecretRef } from '@ethosagent/core';
import type { PersonalityToolsConfig } from '@ethosagent/personalities';
import {
  EthosError,
  isValidSecretName,
  SECRET_NAME_RE,
  type SecretsResolver,
  type Tool,
  type ToolRegistry,
  type ToolSettingsSchema,
  type ToolSettingsSecretBindingField,
} from '@ethosagent/types';
import type { ConfigRepository, ToolSettingsSlot } from '../repositories/config.repository';
import type { PersonalitiesService } from './personalities.service';

// Generic per-tool settings surface (Phase 2, web-search-provider-selection).
//
// A tool that declares a `settingsSchema` becomes configurable per personality.
// The web UI renders a form FROM the schema and writes back a binding here. The
// storage target differs by personality type:
//   • custom personality  → its own `tools.yaml` (travels on export)
//   • read-only built-in   → the global `toolSettings[<id>]` config slot
//   • global default       → the `toolSettings._default` config slot
// Only a secret NAME is ever persisted — never a value (§V S9). `web_search` is
// the sole consumer in v1.

/**
 * Wire shape: settings key → fieldKey → string value. Schema-driven and
 * generic; only fields a tool's `settingsSchema` declares are meaningful.
 *
 * The settings key is the tool's `settingsKey` when it declares one, otherwise
 * its name — so two tools sharing one credential (`youtube_search` /
 * `youtube_comments`) address ONE entry here, the same way they address one
 * stored binding. A key no registered tool claims is REFUSED, not ignored —
 * see `assertClaimedKeys`.
 *
 * A payload is a PATCH: a key it omits keeps whatever is stored, and a key it
 * carries with an empty or invalid value clears that binding. The Security
 * pane sends `{ web_search: … }` and nothing else, so a whole-slot replace
 * here erased every other binding the operator had set.
 */
export type ToolSettingsValues = Record<string, Record<string, string>>;

const WEB_SEARCH_PROVIDERS = ['exa', 'tavily', 'brave'] as const;
type WebSearchProvider = (typeof WEB_SEARCH_PROVIDERS)[number];

/** Which rung of the shared secret ladder supplied the resolved ref. */
export type ToolCredentialRung =
  | 'personality'
  | 'global-personality'
  | 'global-default'
  | 'tool-default';

export type ToolCredentialOrigin = 'set-here' | 'inherited' | 'unset';

export interface ToolCredentialProbe {
  key: string;
  toolNames: string[];
  ref: string;
  rung: ToolCredentialRung;
  present: boolean;
  origin: ToolCredentialOrigin;
}

export interface ToolSettingsServiceOptions {
  config: ConfigRepository;
  personalities: PersonalitiesService;
  /** Vault — presence checks only; the probe never returns a value. */
  secrets: SecretsResolver;
  /** Live registry — the source of each tool's `settingsSchema`. */
  toolRegistry?: ToolRegistry;
}

export class ToolSettingsService {
  constructor(private readonly opts: ToolSettingsServiceOptions) {}

  /** Every configurable tool's schema, so the UI can render forms without any
   *  tool-specific knowledge. */
  schemas(): {
    tools: Array<{ name: string; settingsKey?: string; settingsSchema: ToolSettingsSchema }>;
  } {
    const tools = this.opts.toolRegistry?.getAvailable() ?? [];
    const out: Array<{ name: string; settingsKey?: string; settingsSchema: ToolSettingsSchema }> =
      [];
    for (const t of tools) {
      if (!t.settingsSchema) continue;
      // `settingsKey` travels so the UI can group tools that share one
      // credential into one form. Omitted when the tool does not declare one —
      // the client's `settingsKey ?? name` fallback is the default.
      out.push({
        name: t.name,
        ...(t.settingsKey ? { settingsKey: t.settingsKey } : {}),
        settingsSchema: t.settingsSchema,
      });
    }
    return { tools: out };
  }

  /** Read the global default binding (`toolSettings._default`). */
  async getDefault(): Promise<{ values: ToolSettingsValues }> {
    const raw = await this.opts.config.read();
    return { values: fromSlot(raw?.toolSettings._default) };
  }

  /** Write the global default binding. */
  async setDefault(values: ToolSettingsValues): Promise<{ ok: true }> {
    this.assertClaimedKeys(values);
    await this.writeGlobalSlot('_default', values);
    return { ok: true };
  }

  /**
   * The binding keys a write may create: `settingsKey ?? name` over every
   * registered tool that declares a `settingsSchema` — literally the expression
   * `groupToolSettings` (apps/web/src/lib/tool-settings-form.ts) uses to decide
   * which forms to render, so the surface that renders a form and the surface
   * that accepts its write agree by construction rather than by review (D6).
   *
   * `null` when no registry is wired. The service cannot enumerate a key space
   * it cannot see, so it refuses nothing and stores what it is given: the
   * refusal is a UI-path guarantee, not an invariant of the service.
   */
  private settingsKeySpace(): Set<string> | null {
    const tools = this.opts.toolRegistry?.getAvailable();
    if (!tools) return null;
    const keys = new Set<string>();
    for (const t of tools) {
      if (t.settingsSchema) keys.add(t.settingsKey ?? t.name);
    }
    return keys;
  }

  /**
   * Refuse a payload key no registered tool claims. This error is the entire
   * difference from the behaviour it replaces: a key outside the roster used to
   * be dropped by the slot writer, with `{ ok: true }` returned and the value
   * evaporating between the wire and the disk (D7). The READ side stays
   * permissive — parse preserves an unclaimed key so a newer build's file
   * survives an older build reading it.
   */
  private assertClaimedKeys(values: ToolSettingsValues): void {
    const space = this.settingsKeySpace();
    if (!space) return;
    for (const key of Object.keys(values)) {
      if (space.has(key)) continue;
      throw new EthosError({
        code: 'INVALID_INPUT',
        cause: `No registered tool claims settings key "${key}".`,
        action:
          space.size > 0
            ? `Registered keys: ${[...space].sort().join(', ')}.`
            : 'No registered tool declares a settings schema on this deployment.',
      });
    }
  }

  /**
   * Read a personality's effective binding + which store owns it. Custom
   * personalities read their own `tools.yaml`; built-ins read the global
   * `toolSettings[<id>]` slot (the only writable place for them).
   */
  async getForPersonality(
    personalityId: string,
  ): Promise<{ values: ToolSettingsValues; storage: 'personality' | 'global' }> {
    if (this.opts.personalities.isBuiltin(personalityId)) {
      const raw = await this.opts.config.read();
      return { values: fromSlot(raw?.toolSettings[personalityId]), storage: 'global' };
    }
    return {
      values: fromSlot(this.opts.personalities.getToolsConfig(personalityId)),
      storage: 'personality',
    };
  }

  /** Write a personality's binding to the correct store for its type. */
  async setForPersonality(
    personalityId: string,
    values: ToolSettingsValues,
  ): Promise<{ ok: true; storage: 'personality' | 'global' }> {
    this.assertClaimedKeys(values);
    if (this.opts.personalities.isBuiltin(personalityId)) {
      await this.writeGlobalSlot(personalityId, values);
      return { ok: true, storage: 'global' };
    }
    // requirePersonality + built-in guard live in the service method.
    // `writeToolsConfig` re-renders the WHOLE tools.yaml with no merge of its
    // own, so the merge has to happen here against what is already on disk.
    const existing = this.opts.personalities.getToolsConfig(personalityId);
    await this.opts.personalities.writeToolsConfig(personalityId, mergeSlot(existing, values));
    return { ok: true, storage: 'personality' };
  }

  /**
   * Read-only resolution probe (plan/phases/tool-credential-surface.md D9).
   *
   * Per secret-bearing settings group in the personality's toolset: the ref
   * `resolveToolSecretRef` would hand the tool, which rung supplied it, and
   * whether a non-empty value sits at that ref. Never the value.
   */
  async probeCredentials(personalityId: string): Promise<{ credentials: ToolCredentialProbe[] }> {
    const config = await this.opts.personalities.config(personalityId);
    const toolset = new Set(config.toolset ?? []);
    const builtin = this.opts.personalities.isBuiltin(personalityId);
    const raw = await this.opts.config.read();
    // Custom: tools.yaml → toolSettings[pid] → _default. Built-in: no
    // tools.yaml (directory is read-only), so the ladder starts at the
    // global per-personality slot — still labelled `global-personality`.
    const personalitySlot = builtin
      ? undefined
      : this.opts.personalities.getToolsConfig(personalityId);
    const globalPersonalitySlot = raw?.toolSettings[personalityId];
    const globalDefaultSlot = raw?.toolSettings._default;

    const groups = groupSecretBearingTools(
      (this.opts.toolRegistry?.getAvailable() ?? []).filter((t) => toolset.has(t.name)),
    );

    const credentials: ToolCredentialProbe[] = [];
    for (const group of groups) {
      const labeledRungs: Array<{
        label: ToolCredentialRung;
        binding: ToolSecretRung | undefined;
      }> = builtin
        ? [
            {
              label: 'global-personality',
              binding: bindingForKey(globalPersonalitySlot, group.key),
            },
            { label: 'global-default', binding: bindingForKey(globalDefaultSlot, group.key) },
          ]
        : [
            { label: 'personality', binding: bindingForKey(personalitySlot, group.key) },
            {
              label: 'global-personality',
              binding: bindingForKey(globalPersonalitySlot, group.key),
            },
            { label: 'global-default', binding: bindingForKey(globalDefaultSlot, group.key) },
          ];

      const prefix = secretPrefixForGroup(
        group,
        labeledRungs.map((r) => r.binding),
      );
      if (!prefix) continue;
      const defaultName = group.binding.defaultSecretName ?? 'apiKey';
      const defaultRef = `${prefix}${defaultName}`;
      const rungs = labeledRungs.map((r) => r.binding);
      const ref = resolveToolSecretRef({ rungs, prefix, defaultRef });
      const rung = winningRung(labeledRungs, ref, prefix);
      const value = await this.opts.secrets.get(ref);
      const present = value !== null && value !== '';
      credentials.push({
        key: group.key,
        toolNames: group.toolNames,
        ref,
        rung,
        present,
        origin: present
          ? rung === 'personality' || rung === 'global-personality'
            ? 'set-here'
            : 'inherited'
          : 'unset',
      });
    }
    return { credentials };
  }

  private async writeGlobalSlot(pid: string, values: ToolSettingsValues): Promise<void> {
    assertSafeSlotKey(pid);
    // `ConfigRepository.update` replaces a slot wholesale (its own comment says
    // "slot-level replace, patch wins"), so read the slot and patch it here.
    // Limitation: this read sits OUTSIDE `update`'s write chain, so two saves
    // racing on the same slot can still have the later one merge onto a stale
    // read. Nothing here serializes that; the chain only orders the writes.
    const raw = await this.opts.config.read();
    await this.opts.config.update({
      toolSettings: { [pid]: mergeSlot(raw?.toolSettings[pid], values) },
    });
  }
}

/** Object keys reserved by the JS object model — never let one become a
 *  computed own-key, or it seeds a prototype-pollution reservoir on the
 *  serialized config. */
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Guard the personality/slot id used as a computed object key on `toolSettings`.
 *  Rejects anything outside the alnum/hyphen/underscore shape and the reserved
 *  object-model names. `_default` (the global fallback slot) passes. */
function assertSafeSlotKey(pid: string): void {
  if (!isValidSecretName(pid) || RESERVED_KEYS.has(pid)) {
    throw new EthosError({
      code: 'INVALID_INPUT',
      cause: `Invalid personality id "${pid}".`,
      action: 'Use letters, digits, hyphens, and underscores only.',
    });
  }
}

/**
 * Patch a stored slot with an incoming payload. A key the payload OMITS keeps
 * whatever is stored; a key it carries replaces that binding, clearing it when
 * the value is empty or fails narrowing.
 *
 * `web_search` is field-level: a payload that carries `{ web_search: { secret } }`
 * (Reset / Override) must not wipe `provider` or `recency`. Secret-only keys
 * stay whole-binding replace — they have only one field.
 *
 * Both stores need this: `ConfigRepository.update` replaces a `toolSettings`
 * slot wholesale, and `writeToolsConfig` re-renders the whole tools.yaml. With
 * a single-key payload (which is what the Security pane's web-search form
 * sends) a whole-slot write erases every binding the form does not own.
 */
function mergeSlot(
  existing: ToolSettingsSlot | undefined,
  values: ToolSettingsValues,
): PersonalityToolsConfig {
  const next: PersonalityToolsConfig = {};
  const ws = mergeWebSearch(existing?.web_search, values);
  if (Object.keys(ws).length > 0) next.web_search = ws;
  // The union of what is stored and what the payload carries, not a fixed
  // roster (D6). A fixed roster silently deleted a stored binding whose tool
  // this process does not have registered — the exact loss D14 promises against
  // — because a key it did not list was never copied across.
  const keys = new Set([...Object.keys(existing ?? {}), ...Object.keys(values)]);
  for (const key of keys) {
    if (key === 'web_search' || RESERVED_KEYS.has(key)) continue;
    const binding = toSecretBinding(values[key] ?? existing?.[key]);
    if (binding.secret) next[key] = binding;
  }
  return next;
}

/**
 * Field-level PATCH for `web_search`. Omitted key → keep existing. Own-keys of
 * the incoming object each run through `toWebSearch` narrowing; empty/invalid
 * clears that field only so Reset (`{ secret: '' }`) and Override
 * (`{ secret }` ± `provider`) preserve the rest.
 */
function mergeWebSearch(
  existing: { provider?: string; secret?: string; recency?: string } | undefined,
  values: ToolSettingsValues,
): { provider?: WebSearchProvider; secret?: string; recency?: string } {
  if (!('web_search' in values)) return toWebSearch(existing);
  const incoming = values.web_search ?? {};
  const merged: { provider?: string; secret?: string; recency?: string } = {
    ...(existing?.provider ? { provider: existing.provider } : {}),
    ...(existing?.secret ? { secret: existing.secret } : {}),
    ...(existing?.recency ? { recency: existing.recency } : {}),
  };
  for (const key of ['provider', 'secret', 'recency'] as const) {
    if (!Object.hasOwn(incoming, key)) continue;
    const narrowed = toWebSearch({ [key]: incoming[key] });
    if (narrowed[key] !== undefined) {
      merged[key] = narrowed[key];
    } else {
      delete merged[key];
    }
  }
  return toWebSearch(merged);
}

/** Map the on-disk / stored bindings to the generic wire shape, omitting empty
 *  fields so the UI shows "unset" rather than blank strings. */
function fromSlot(slot: ToolSettingsSlot | undefined): ToolSettingsValues {
  const out: ToolSettingsValues = {};
  const ws = slot?.web_search;
  if (ws) {
    const fields: Record<string, string> = {};
    if (ws.provider) fields.provider = ws.provider;
    if (ws.secret) fields.secret = ws.secret;
    // Read side of the `recency` binding. `fromSlot` builds `fields` key by
    // key, so a key omitted here never reaches the UI however faithfully it was
    // written — the write narrowing in `toWebSearch` is only half the round trip.
    if (ws.recency) fields.recency = ws.recency;
    if (Object.keys(fields).length > 0) out.web_search = fields;
  }
  // Every remaining key the slot carries, so a binding the write side can store
  // is one the UI can display. `youtube` was modelled in storage and rendered to
  // tools.yaml but missing here, so it could never be shown or re-saved; the
  // fixed roster that fixed that had the same failure for a key outside it.
  for (const key of Object.keys(slot ?? {})) {
    if (key === 'web_search') continue;
    const secret = slot?.[key]?.secret;
    if (secret) out[key] = { secret };
  }
  return out;
}

/** Narrow a binding whose only field is a secret NAME, validated with the same
 *  rule the vault enforces. Shared by `x_search`, `engine_ask`, `youtube` and
 *  every future roster key shaped like them. */
function toSecretBinding(source: { secret?: string } | undefined): { secret?: string } {
  const secret = source?.secret?.trim();
  return secret && isValidSecretName(secret) ? { secret } : {};
}

/** Narrow the generic wire values into the typed web_search binding. Unknown
 *  providers and empty strings are dropped (treated as unset). */
function toWebSearch(fields: { provider?: string; secret?: string; recency?: string } = {}): {
  provider?: WebSearchProvider;
  secret?: string;
  recency?: string;
} {
  const out: { provider?: WebSearchProvider; secret?: string; recency?: string } = {};
  const provider = fields.provider?.trim();
  if (provider && (WEB_SEARCH_PROVIDERS as readonly string[]).includes(provider)) {
    out.provider = provider as WebSearchProvider;
  }
  // The secret is a NAME reference persisted into a `providers/<p>/<name>` ref;
  // validate it with the same shared rule the vault enforces so a malformed
  // name can never reach the personality's tools.yaml or the config slot.
  const secret = fields.secret?.trim();
  if (secret && isValidSecretName(secret)) out.secret = secret;
  // `recency` is a default `max_age` duration (`30d`, `6m`, `1y`). LEXICAL
  // boundary check, shared with packages/config, which persists the same key: it
  // applies `parseMaxAge`'s trim/lowercase and shape and stores the NORMALIZED
  // form (`30D` -> `30d`), but NOT `parseMaxAge`'s rejection of a zero quantity
  // — `0d` persists and is ignored at read time. `parseMaxAge` in
  // `@ethosagent/tools-web` (`src/max-age.ts`) remains the SEMANTIC authority
  // and the two MUST change together; it is not imported because the layer model
  // runs types <- core <- extensions <- apps and web-api has no dependency on
  // the tools-web extension. A duplicated lexical check at a persistence
  // boundary is the precedent CLAUDE.md records for the ssh known-hosts check.
  //
  // Unlike `secret`, a value that is not a duration drops only THIS FIELD and
  // leaves the rest of the binding intact: a malformed secret name would
  // silently bind a DIFFERENT key, while a malformed recency is just a missing
  // default filter.
  const recency = fields.recency ? normalizeWebSearchRecency(fields.recency) : null;
  if (recency) out.recency = recency;
  return out;
}

// ---------------------------------------------------------------------------
// Probe helpers — keep the ladder rebuild next to the stores it reads.
// ---------------------------------------------------------------------------

interface ToolSecretRung {
  secret?: string;
  provider?: string;
}

interface SecretBearingGroup {
  key: string;
  toolNames: string[];
  /** First tool in the group — supplies capabilities + schema. */
  tool: Tool;
  binding: ToolSettingsSecretBindingField;
}

/** Group tools by settings slot, keep only groups with a secret-binding field. */
function groupSecretBearingTools(tools: Tool[]): SecretBearingGroup[] {
  const groups: SecretBearingGroup[] = [];
  const byKey = new Map<string, SecretBearingGroup>();
  for (const tool of tools) {
    const schema = tool.settingsSchema;
    if (!schema) continue;
    const binding = schema.fields.find(
      (f): f is ToolSettingsSecretBindingField => f.kind === 'secret-binding',
    );
    if (!binding) continue;
    const key = tool.settingsKey ?? tool.name;
    const existing = byKey.get(key);
    if (existing) {
      existing.toolNames.push(tool.name);
      continue;
    }
    const group: SecretBearingGroup = {
      key,
      toolNames: [tool.name],
      tool,
      binding,
    };
    byKey.set(key, group);
    groups.push(group);
  }
  return groups;
}

function bindingForKey(
  slot: ToolSettingsSlot | PersonalityToolsConfig | undefined,
  key: string,
): ToolSecretRung | undefined {
  if (!slot) return undefined;
  if (key === 'web_search') {
    const ws = slot.web_search;
    if (!ws) return undefined;
    return { secret: ws.secret, provider: ws.provider };
  }
  const secret = slot[key]?.secret;
  return secret !== undefined ? { secret } : undefined;
}

/**
 * Vault namespace prefix for a group. Ordinary tools take the first manageable
 * `providers/<segment>/*` grant. `web_search` picks the bound provider's
 * namespace when one is set — the tool resolves `providers/<provider>/<name>`
 * rather than one static prefix.
 */
function secretPrefixForGroup(
  group: SecretBearingGroup,
  rungs: ReadonlyArray<ToolSecretRung | undefined>,
): string | undefined {
  const prefixes = manageableProviderPrefixes(group.tool.capabilities.secrets);
  if (prefixes.length === 0) return undefined;

  if (group.key === 'web_search') {
    for (const rung of rungs) {
      const provider = rung?.provider?.trim();
      if (provider && (WEB_SEARCH_PROVIDERS as readonly string[]).includes(provider)) {
        return `providers/${provider}/`;
      }
    }
    // No provider on any rung: the tool's runtime then picks the first
    // available backend. Mirror that here by taking the first declared
    // manageable prefix (exa → tavily → brave in the capability list).
    return prefixes[0];
  }

  return prefixes[0];
}

/** `providers/<segment>/*` → `providers/<segment>/`, same shape as the roster. */
function manageableProviderPrefixes(secrets: readonly string[] | undefined): string[] {
  const out: string[] = [];
  for (const declared of secrets ?? []) {
    if (!declared.endsWith('/*')) continue;
    const body = declared.slice(0, -2);
    const segments = body.split('/');
    const provider = segments[1];
    if (segments.length !== 2 || segments[0] !== 'providers' || !provider) continue;
    if (!SECRET_NAME_RE.test(provider)) continue;
    out.push(`${body}/`);
  }
  return out;
}

/**
 * Which labeled rung supplied `ref`. Walks with the same validity rule as
 * `resolveToolSecretRef`; if none matched, the ref is the tool default.
 */
function winningRung(
  labeled: ReadonlyArray<{ label: ToolCredentialRung; binding: ToolSecretRung | undefined }>,
  ref: string,
  prefix: string,
): ToolCredentialRung {
  for (const { label, binding } of labeled) {
    const name = binding?.secret?.trim();
    if (name && isValidSecretName(name) && `${prefix}${name}` === ref) return label;
  }
  return 'tool-default';
}
