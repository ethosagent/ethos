// Tier-1 short-pattern check (Ch.3c).
//
// High-precision regex catalog covering the injection shapes that fit in
// fewer than 500 chars — chat-template tokens that survived sanitization,
// `ignore previous instructions` family, role-override phrases, mid-document
// `system:` lines, and bidi/zero-width control characters. A hit flags the
// content with `containsInstructions: true` regardless of length and (per
// the chapter plan) escalates to the LLM classifier.
//
// This list is *not* the boundary — it is the floor that runs free on every
// untrusted result. Real defense-in-depth comes from layering wrapper +
// pattern-check + (optional) LLM classifier + post-read tool downgrade.
const PATTERNS = [
  // Chat-template tokens that slipped past sanitize() (different escaping,
  // unicode-fullwidth pipes, etc.). Catch the bare token shape.
  { rule: 'template-token', pattern: /<\|(?:im_start|im_end|im_sep|eot_id|begin_of_text)/i },
  { rule: 'template-token', pattern: /<<SYS>>|\[INST\]|<start_of_turn>/i },
  // Direct prompt-injection phrases.
  {
    rule: 'ignore-instructions',
    pattern: /ignore (?:all )?(?:previous|prior|above) instructions/i,
  },
  { rule: 'disregard', pattern: /disregard (?:the )?(?:above|previous|prior)/i },
  { rule: 'forget-instructions', pattern: /forget (?:everything|all|previous|prior)/i },
  { rule: 'role-override', pattern: /you are now(?: an?)? [a-z][a-z0-9 _-]{2,}/i },
  { rule: 'new-instructions', pattern: /^\s*new instructions:/im },
  // Mid-document role markers that mimic a system turn.
  { rule: 'inline-system', pattern: /^\s*system:\s/im },
  { rule: 'inline-assistant', pattern: /^\s*assistant:\s/im },
  // Hidden Unicode controls — bidi overrides, zero-width chars, RTL embeds.
  // (Cherry-pick the few that show up in real attacks; full Unicode-control
  // sweep belongs in a separate review path.)
  { rule: 'bidi-override', pattern: /[‪-‮⁦-⁩]/ },
  { rule: 'zero-width', pattern: /[​-‍﻿]/ },
];
/**
 * Run the regex catalog against `content`. Returns every match (deduped by
 * rule) along with a short excerpt for telemetry / UI. Empty `hits` =
 * `containsInstructions` is false.
 */
export function shortPatternCheck(content) {
  if (!content) return { containsInstructions: false, hits: [] };
  const seenRules = new Set();
  const hits = [];
  for (const { rule, pattern } of PATTERNS) {
    if (seenRules.has(rule)) continue;
    const match = pattern.exec(content);
    if (match) {
      seenRules.add(rule);
      hits.push({ rule, excerpt: excerpt(match[0]) });
    }
  }
  return { containsInstructions: hits.length > 0, hits };
}
function excerpt(text, maxLen = 80) {
  const trimmed = text.trim();
  return trimmed.length > maxLen ? `${trimmed.slice(0, maxLen)}…` : trimmed;
}
