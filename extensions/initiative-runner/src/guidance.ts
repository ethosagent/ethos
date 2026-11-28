import type { GuidanceMapping } from '@ethosagent/types';

export type GuidanceLevel = 'personality' | 'initiative' | 'idea';

/** Acting verbs. Guidance is advice, never permission (R8). */
const ACTING =
  /\b(post|send|create|message|email|file a ticket|schedule|reply|tweet|dm|publish|comment|delete|update|upload|invite|buy|purchase|deploy|merge|push)\b/i;
const ACTING_REASON =
  'guidance cannot grant actions: initiative runs are read-only and never post, send or create';

/** `~`, a multi-segment absolute path (preceded by start/space, so URLs and `and/or` pass), `.env`, `.pem`, `id_rsa`. */
const FS_PATH =
  /(?:^|\s)(?:~(?:\/|\s|$)|\/[\w.-]+\/)|\.(?:env|pem)\b|\bid_(?:rsa|dsa|ecdsa|ed25519)\b/i;
const FS_PATH_REASON = 'guidance cannot grant file access; add a source instead';

const NO_CONNECTOR = 'no read-only connector';
const NOT_IN_TOOLSET = "not in this personality's toolset";
const HOST_RE = /\b((?:[a-z0-9-]+\.)+(?:com|io|org|net|dev|ai|co|app))\b/i;

function normalize(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}

function viaTool(
  text: string,
  candidates: readonly string[],
  toolset: readonly string[],
): GuidanceMapping {
  const hit = candidates.find((t) => toolset.includes(t));
  return hit
    ? { text, status: 'mapped', mapsTo: [hit] }
    : { text, status: 'unreachable', mapsTo: [], reason: NOT_IN_TOOLSET };
}

function mapLine(text: string, toolset: readonly string[]): GuidanceMapping {
  if (ACTING.test(text)) return { text, status: 'refused', mapsTo: [], reason: ACTING_REASON };
  if (FS_PATH.test(text)) return { text, status: 'refused', mapsTo: [], reason: FS_PATH_REASON };
  if (/\b(mixpanel|amplitude)\b/i.test(text) || /\bslack\b/i.test(text)) {
    return { text, status: 'unreachable', mapsTo: [], reason: NO_CONNECTOR };
  }
  if (/\blinkedin\b/i.test(text)) return viaTool(text, ['linkedin_search'], toolset);
  if (/\breddit\b/i.test(text))
    return viaTool(text, ['reddit_web_search', 'reddit_search'], toolset);
  if (/\b(twitter|x)\b/i.test(text)) return viaTool(text, ['x_search'], toolset);
  const host = /\bg2\b/i.test(text) ? 'g2.com' : HOST_RE.exec(text)?.[1]?.toLowerCase();
  if (host) {
    return toolset.includes('web_search')
      ? { text, status: 'mapped', mapsTo: [`web_search:${host}`] }
      : { text, status: 'unreachable', mapsTo: [], reason: NOT_IN_TOOLSET };
  }
  // "our code" / "our repo": read_file, and the caller gates on a repo source.
  if (/\bour (code|repo)\b/i.test(text)) return viaTool(text, ['read_file'], toolset);
  return { text, status: 'mapped', mapsTo: [] };
}

/**
 * Deterministic keyword table, no LLM. `ctx.level` is carried for callers that
 * tag mappings by source level; the mapping itself does not depend on it.
 * "our code/repo" maps to `read_file` only; the "only if a source covers it"
 * check belongs to the caller (InitiativeConfigService), which knows `sources`.
 */
export function mapGuidance(
  lines: readonly string[],
  ctx: { toolset: readonly string[]; level: GuidanceLevel },
): GuidanceMapping[] {
  return lines.map((line) => mapLine(line, ctx.toolset));
}

/** Most specific wins: idea over initiative over personality, keyed by normalised text. */
export function mergeGuidance(
  personality: GuidanceMapping[],
  initiative: GuidanceMapping[],
  idea: GuidanceMapping[],
): GuidanceMapping[] {
  const merged = new Map<string, GuidanceMapping>();
  for (const level of [personality, initiative, idea]) {
    for (const m of level) merged.set(normalize(m.text), m);
  }
  return [...merged.values()];
}
