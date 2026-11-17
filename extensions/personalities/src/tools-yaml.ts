import { isValidSecretName } from '@ethosagent/types';
import type { PersonalityToolsConfig } from './types';

// ---------------------------------------------------------------------------
// tools.yaml — per-personality tool config (source of truth). A sibling
// artifact to config.yaml / toolset.yaml / mcp.yaml, NOT a field on the frozen
// PersonalityConfig schema. A binding carries a secret NAME only — never a
// value (§V S9) — so the directory stays shareable and committable.
// ---------------------------------------------------------------------------

const RECENCY_SHAPE = /^\d{1,4}[dwmy]$/;

/**
 * Normalize a hand-written `web_search.recency` value, or `null` if it is not a
 * duration at all. Trims and lowercases first, then shape-tests, and returns the
 * NORMALIZED form — so a `tools.yaml` written by hand as `recency: 30D` persists
 * as `30d` rather than vanishing without a word.
 *
 * Private twin of `normalizeWebSearchRecency` in `@ethosagent/config`; the two
 * MUST change together. Not imported from there because this package does not
 * depend on `@ethosagent/config` and a workspace dependency for one regex costs
 * more than the duplication. See `parseToolsYaml` for what this does and does
 * not enforce relative to `parseMaxAge`.
 */
function normalizeRecency(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  return RECENCY_SHAPE.test(normalized) ? normalized : null;
}

/**
 * The binding keys with a NAMED field on `PersonalityToolsConfig` — the typed
 * roster, not a gate. `parseToolsYaml` preserves a key outside it and
 * `renderToolsYaml` re-emits it, because the real key space is whatever
 * `settingsKey ?? name` the registered tools declare and this layer cannot see
 * the registry (plan/phases/tool-credential-surface.md D6/D7). What the tuple
 * still buys: `web_search`'s three-field shape stays distinct from a bare
 * `{secret}`, and `renderToolsYaml` emits these first, in this order, so an
 * existing file's byte layout does not shuffle when an unknown key joins it.
 * Every key but `web_search` carries a secret NAME and nothing else.
 */
export const TOOLS_YAML_KEYS = [
  'web_search',
  'x_search',
  'engine_ask',
  'youtube',
  'search_console',
] as const;

export type ToolsYamlKey = (typeof TOOLS_YAML_KEYS)[number];

/** The typed roster minus `web_search` — the keys whose only field is a secret
 *  NAME, in declaration order. Render emits these before preserved keys. */
const SECRET_ONLY_YAML_KEYS: readonly string[] = TOOLS_YAML_KEYS.filter((k) => k !== 'web_search');

/** Object keys reserved by the JS object model. A `tools.yaml` line naming one
 *  would set the parsed object's PROTOTYPE rather than a binding, so it is
 *  skipped on both sides. Twin of `RESERVED_KEYS` in web-api's tool-settings
 *  service, which guards the same hazard on the slot id. */
const RESERVED_YAML_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function parseInlineToolMap(s: string): Record<string, string> {
  const inner = s.replace(/^\{/, '').replace(/\}$/, '').trim();
  const out: Record<string, string> = {};
  if (!inner) return out;
  for (const pair of inner.split(',')) {
    const idx = pair.indexOf(':');
    if (idx === -1) continue;
    const k = pair.slice(0, idx).trim();
    const v = pair
      .slice(idx + 1)
      .trim()
      .replace(/^["']|["']$/g, '');
    // A reserved field name would write the object's PROTOTYPE, not a field.
    if (k && !RESERVED_YAML_KEYS.has(k)) out[k] = v;
  }
  return out;
}

/**
 * Parse a personality-directory `tools.yaml`. Supports the documented inline
 * flow-map form and the equivalent block form:
 *
 *   web_search: { provider: exa, secret: exa-main }
 *   x_search: { secret: xai-main }
 *   engine_ask: { secret: openai-brand }
 *   youtube: { secret: yt-main }
 *   # or
 *   web_search:
 *     provider: exa
 *     secret: exa-main
 *
 * A key outside `TOOLS_YAML_KEYS` is PRESERVED as a `{secret}` binding, not
 * dropped: this layer cannot see the tool registry, and a parser that discards
 * what it cannot validate makes an older build delete a newer build's file
 * (D7). The write boundary refuses an unclaimed key instead.
 */
export function parseToolsYaml(src: string): PersonalityToolsConfig {
  const out: PersonalityToolsConfig = {};
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    const tool = m?.[1];
    if (!m || !tool || RESERVED_YAML_KEYS.has(tool)) continue;
    const rest = (m[2] ?? '').trim();
    let entry: Record<string, string> = {};
    if (rest.startsWith('{')) {
      entry = parseInlineToolMap(rest);
    } else if (rest === '') {
      let j = i + 1;
      while (j < lines.length) {
        const bl = lines[j] ?? '';
        if (bl.trim() === '' || bl.trim().startsWith('#')) {
          j++;
          continue;
        }
        const indent = bl.match(/^(\s*)/)?.[1]?.length ?? 0;
        if (indent === 0) break;
        const bm = bl.match(/^\s+(\w+):\s*(.+)$/);
        if (bm && !RESERVED_YAML_KEYS.has(bm[1])) {
          entry[bm[1]] = bm[2].trim().replace(/^["']|["']$/g, '');
        }
        j++;
      }
      i = j - 1;
    }
    // `tools.yaml` is personality-owned and therefore UNTRUSTED input
    // (marketplace / imported personalities). A `secret` value flows into a
    // `providers/<provider>/<name>` ref that must stay inside web_search's
    // capability prefix grant — so it is validated with the same shared rule
    // the vault enforces. An out-of-shape secret drops the WHOLE binding: a
    // provider without its intended key must not silently fall back to a
    // different (default) key.
    if (entry.secret && !isValidSecretName(entry.secret)) continue;
    if (tool !== 'web_search') {
      // Every other key — the four typed secret-only roster keys and any key
      // this build does not know — is a FIELD MAP of secret NAMES: `{ secret }`
      // for a one-provider tool, `{ chatgpt, perplexity }` for `engine_ask`
      // (plan engine-ask-per-engine-bindings D1). A field name outside the
      // secret-name shape is skipped; a field VALUE outside it drops the whole
      // binding, the same rule as `secret` above (D13).
      const fields = secretFieldMap(entry);
      if (fields === null) continue;
      if (Object.keys(fields).length > 0) out[tool] = fields;
      continue;
    }
    const ws: NonNullable<PersonalityToolsConfig['web_search']> = {};
    if (entry.provider === 'exa' || entry.provider === 'tavily' || entry.provider === 'brave') {
      ws.provider = entry.provider;
    }
    if (entry.secret) ws.secret = entry.secret;
    // `recency` is a duration string (`30d`, `6m`, `1y`). This is a LEXICAL
    // boundary check: it applies `parseMaxAge`'s trim/lowercase and shape, and
    // stores the NORMALIZED form, so a hand-written `recency: 30D` survives as
    // `30d` instead of being silently dropped. It does NOT apply `parseMaxAge`'s
    // rejection of a zero quantity — `0d` persists here and is ignored at read
    // time, which keeps that one rule in one place. `parseMaxAge` in
    // `@ethosagent/tools-web` (`src/max-age.ts`) remains the semantic authority
    // and the two MUST change together. It is not imported here — the layer
    // model (types <- core <- extensions <- apps, ARCHITECTURE.md §II) does not
    // let a persistence boundary reach for another extension's parser, so the
    // check is duplicated at each boundary the same way the lexical ssh
    // known-hosts check is (see CLAUDE.md's execution-ssh carve-out).
    //
    // Note the asymmetry with `secret` above: an out-of-shape secret drops the
    // WHOLE binding, because a provider without its intended key would silently
    // fall back to a DIFFERENT key. A recency that is not a duration drops only
    // THIS FIELD — a missing default filter, not a wrong credential.
    const recency = entry.recency ? normalizeRecency(entry.recency) : null;
    if (recency) ws.recency = recency;
    if (ws.provider || ws.secret || ws.recency) out.web_search = ws;
  }
  return out;
}

/** `web_search`'s two non-secret fields. Beside any other key they are not
 *  part of the shape — a stray `provider:` next to a `secret:` is not a
 *  second credential — so the field map skips them. */
const NON_SECRET_FIELDS = new Set(['provider', 'recency']);

/** The shape-safe secret-name fields of one non-`web_search` binding, or `null`
 *  when any non-empty value is not a valid secret name (the whole binding is
 *  then dropped). Field names must pass `isValidSecretName` and be neither
 *  reserved nor one of `NON_SECRET_FIELDS`; an empty value is an absent field. */
function secretFieldMap(entry: Record<string, string>): Record<string, string> | null {
  const fields: Record<string, string> = {};
  for (const [field, value] of Object.entries(entry)) {
    if (!value || !isValidSecretName(field) || RESERVED_YAML_KEYS.has(field)) continue;
    if (NON_SECRET_FIELDS.has(field)) continue;
    if (!isValidSecretName(value)) return null;
    fields[field] = value;
  }
  return fields;
}

/**
 * Render a `PersonalityToolsConfig` back to the inline flow-map form
 * `parseToolsYaml` reads. Only fields that are set are emitted; a config with
 * no meaningful binding renders to `''` (caller removes the file).
 *
 * Order is stable: `web_search`, then the typed secret-only roster in
 * `TOOLS_YAML_KEYS` order, then every preserved key sorted. So adding a key the
 * typed roster does not claim appends a line rather than reshuffling the file.
 */
export function renderToolsYaml(config: PersonalityToolsConfig): string {
  const lines: string[] = [];
  const ws = config.web_search;
  if (ws) {
    const parts: string[] = [];
    if (ws.provider) parts.push(`provider: ${ws.provider}`);
    if (ws.secret) parts.push(`secret: ${ws.secret}`);
    if (ws.recency) parts.push(`recency: ${ws.recency}`);
    if (parts.length > 0) lines.push(`web_search: { ${parts.join(', ')} }`);
  }
  const preserved = Object.keys(config)
    .filter((k) => k !== 'web_search' && !SECRET_ONLY_YAML_KEYS.includes(k))
    .sort();
  for (const key of [...SECRET_ONLY_YAML_KEYS, ...preserved]) {
    // The key and every field name are emitted only when they match the shared
    // secret-name shape, so a name from a hand-edited file cannot inject
    // anything into the rendered yaml. Every name `parseToolsYaml` stores
    // already satisfies it. Fields are sorted, so a one-field `{ secret }`
    // binding renders byte-identically to what it always did.
    if (!isValidSecretName(key) || RESERVED_YAML_KEYS.has(key)) continue;
    const binding = config[key] ?? {};
    const parts = Object.keys(binding)
      .filter((f) => isValidSecretName(f) && !RESERVED_YAML_KEYS.has(f))
      .sort()
      .flatMap((f) => {
        const value = binding[f];
        return value ? [`${f}: ${value}`] : [];
      });
    if (parts.length > 0) lines.push(`${key}: { ${parts.join(', ')} }`);
  }
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}
