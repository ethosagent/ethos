import { normalizeWebSearchRecency } from '@ethosagent/config';
import type { PersonalityToolsConfig } from '@ethosagent/personalities';
import {
  EthosError,
  isValidSecretName,
  type ToolRegistry,
  type ToolSettingsSchema,
} from '@ethosagent/types';
import {
  type ConfigRepository,
  SECRET_ONLY_TOOL_KEYS,
  type ToolSettingsSlot,
} from '../repositories/config.repository';
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
 * stored binding. A key the write side does not know (`TOOLS_YAML_KEYS`) is
 * ignored.
 *
 * A payload is a PATCH: a key it omits keeps whatever is stored, and a key it
 * carries with an empty or invalid value clears that binding. The Security
 * pane sends `{ web_search: … }` and nothing else, so a whole-slot replace
 * here erased every other binding the operator had set.
 */
export type ToolSettingsValues = Record<string, Record<string, string>>;

const WEB_SEARCH_PROVIDERS = ['exa', 'tavily', 'brave'] as const;
type WebSearchProvider = (typeof WEB_SEARCH_PROVIDERS)[number];

export interface ToolSettingsServiceOptions {
  config: ConfigRepository;
  personalities: PersonalitiesService;
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
    await this.writeGlobalSlot('_default', values);
    return { ok: true };
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
  const ws = toWebSearch(values.web_search ?? existing?.web_search);
  if (Object.keys(ws).length > 0) next.web_search = ws;
  for (const key of SECRET_ONLY_TOOL_KEYS) {
    const binding = toSecretBinding(values[key] ?? existing?.[key]);
    if (binding.secret) next[key] = binding;
  }
  return next;
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
  // Every remaining roster key, so a binding the write side can store is one
  // the UI can display. `youtube` was modelled in storage and rendered to
  // tools.yaml but missing here, so it could never be shown or re-saved.
  for (const key of SECRET_ONLY_TOOL_KEYS) {
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
