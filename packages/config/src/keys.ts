import { join } from 'node:path';
import type { SecretsResolver, Storage } from '@ethosagent/types';
import { ethosDir } from './paths';
import { resolveSecretValue, secretRefFromValue } from './secrets';

// ---------------------------------------------------------------------------
// Key rotation pool
// ---------------------------------------------------------------------------

export interface KeyProfile {
  apiKey: string;
  priority: number;
  label?: string;
}

export async function readKeys(storage: Storage, secrets?: SecretsResolver): Promise<KeyProfile[]> {
  const src = await storage.read(join(ethosDir(), 'keys.json'));
  if (!src) return [];
  try {
    const keys = JSON.parse(src) as KeyProfile[];
    if (secrets) {
      for (const k of keys) {
        k.apiKey = await resolveSecretValue(k.apiKey, secrets);
      }
    }
    return keys;
  } catch {
    return [];
  }
}

/**
 * The vault ref a rotation profile's `apiKey` points at, or `null` when it
 * points at none — a legacy plaintext profile predating externalization never
 * had material stored, so there is nothing to delete.
 *
 * The removal-side counterpart of `externalizeRotationKeys`. `rotationKeyId`
 * hashes the key VALUE, but `readKeys(storage)` — what `ethos keys` uses —
 * hands back the reference string, so the ref is parsed out of it by
 * `secretRefFromValue` rather than re-derived. The profile-shaped signature is
 * what the rotation-pool callers read against; the parsing itself lives in one
 * place.
 *
 * Refs are content-addressed, so two profiles holding the SAME key value share
 * one ref. Callers deleting on removal must check the surviving profiles first.
 */
export function rotationSecretRef(profile: KeyProfile): string | null {
  return secretRefFromValue(profile.apiKey);
}

export interface ActiveContext {
  /** 'personality' = single agent; 'team' = coordinator against a named mesh */
  type: 'personality' | 'team';
  name: string;
}

/** A personality's binding for the `web_search` tool. `secret` is a NAME
 *  only (e.g. `exa-main`) — resolves to `providers/<provider>/<name>` in the
 *  vault. Never a value (§V S9). */
export interface WebSearchToolSetting {
  provider?: 'exa' | 'tavily' | 'brave';
  secret?: string;
  /** Default `max_age` for the tool — a duration string like `30d`, `6m`, `1y`. */
  recency?: string;
}

const WEB_SEARCH_RECENCY_SHAPE = /^\d{1,4}[dwmy]$/;

/**
 * Normalize a hand-written `web_search.recency` value, or `null` if it is not
 * a duration at all. Trims and lowercases first, then shape-tests, and returns
 * the NORMALIZED form — so `' 30D '` persists as `30d` rather than vanishing.
 *
 * `parseMaxAge` in `@ethosagent/tools-web` (`src/max-age.ts`) is the SEMANTIC
 * authority for this grammar and the two MUST change together. It is
 * deliberately not imported: the layer model runs types <- core <- extensions
 * <- apps (ARCHITECTURE.md §II), so `packages/config` importing from
 * `extensions/` is an upward import. A duplicated lexical check at the
 * persistence boundary is the precedent CLAUDE.md records for the ssh
 * known-hosts check.
 *
 * What this boundary enforces, precisely: the same trim/lowercase and the same
 * `^\d{1,4}[dwmy]$` shape `parseMaxAge` applies. What it does NOT enforce is
 * `parseMaxAge`'s rejection of a zero quantity — `0d` persists here and is
 * ignored at read time, which costs nothing and keeps one grammar rule in one
 * place. The boundary is the belt; `parseMaxAge` falling through to "no filter"
 * on a value it cannot use is the braces.
 *
 * Exported so apps/web-api's two hand-written persistence boundaries
 * (`repositories/config.repository.ts` and `services/tool-settings.service.ts`)
 * share this one copy rather than minting their own. `extensions/personalities`
 * keeps a private twin, `normalizeRecency` — it does not depend on
 * `@ethosagent/config` and a workspace dependency for one regex costs more than
 * the duplication; that copy and this one must change together.
 */
export function normalizeWebSearchRecency(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  return WEB_SEARCH_RECENCY_SHAPE.test(normalized) ? normalized : null;
}

/** A personality's binding for the `x_search` tool — one provider (xAI), so
 *  only the secret NAME. Resolves to `providers/xai/<name>`; absent → the
 *  default `providers/xai/apiKey`. */
export interface XSearchToolSetting {
  secret?: string;
}

/** A personality's binding for the `engine_ask` tool — one secret NAME per
 *  answer engine, keyed by engine id (`chatgpt` → `providers/openai/<name>`,
 *  `perplexity` → `providers/perplexity/<name>`); an engine with no name falls
 *  to the next rung and finally to its own default ref. `secret` is the
 *  permanent legacy alias for `chatgpt` and nothing else — the mapping lives in
 *  `selectSecretRef` in `@ethosagent/tools-answer-engines` (plan
 *  engine-ask-per-engine-bindings D2). */
export interface EngineAskToolSetting {
  secret?: string;
  [engineId: string]: string | undefined;
}

/** A personality's binding for `youtube_search` / `youtube_comments` — one
 *  provider (Google), shared by both tools, so only the secret NAME.
 *  Resolves to `providers/google/<name>`; absent → the default
 *  `providers/google/apiKey`. */
export interface YouTubeToolSetting {
  secret?: string;
}

/** A personality's binding for `gsc_sites` / `gsc_queries` — one Google
 *  service account, shared by both tools, so only the secret NAME. Resolves to
 *  `providers/google-search-console/<name>`; absent → the default
 *  `providers/google-search-console/serviceAccount`. */
export interface SearchConsoleToolSetting {
  secret?: string;
}

/**
 * Per-personality tool config. The named fields are the TYPED roster; the index
 * signature is the real key space, which is whatever `settingsKey ?? name` the
 * registered tools declare. This package sits below the tool registry in the
 * layer model (ARCHITECTURE.md §II) and cannot see it, so it parses and renders
 * `toolSettings.<id>.<key>.secret` for any shape-safe `<key>` and leaves the
 * refusal to the write boundary that does have the registry
 * (`ToolSettingsService`, apps/web-api). See D8: the hand-listed render block
 * this replaced omitted `search_console`, so a global Search Console binding
 * was written into this object, dropped by the renderer, and gone on the next
 * read — rungs 2 and 3 of the four-rung ladder dead while rung 1 worked.
 */
export interface PersonalityToolSettings {
  web_search?: WebSearchToolSetting;
  x_search?: XSearchToolSetting;
  engine_ask?: EngineAskToolSetting;
  youtube?: YouTubeToolSetting;
  search_console?: SearchConsoleToolSetting;
  [key: string]:
    | WebSearchToolSetting
    | { secret?: string; [field: string]: string | undefined }
    | undefined;
}

/** Object keys reserved by the JS object model — never let one become a
 *  computed own-key on a parsed slot, or a hand-edited config.yaml seeds a
 *  prototype-pollution reservoir. */
export const RESERVED_TOOL_SETTINGS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** The slot `toolSettings[id]` names, created when absent. An OWN lookup: an
 *  inherited name (`toString`) must yield a fresh slot, never the shared
 *  builtin it would otherwise read through to and then mutate. */
export function ownToolSettingsSlot(
  toolSettings: ToolSettingsMap,
  id: string,
): PersonalityToolSettings {
  const slot = (Object.hasOwn(toolSettings, id) ? toolSettings[id] : undefined) ?? {};
  toolSettings[id] = slot;
  return slot;
}

/** Global FALLBACK map: personality ID (or `_default`) → per-tool config. */
export type ToolSettingsMap = Record<string, PersonalityToolSettings>;
