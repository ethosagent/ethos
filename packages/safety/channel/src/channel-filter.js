import { generateCode } from './pairing-store';

// ---------------------------------------------------------------------------
// Glob matching (email only — simple suffix match for *@domain.com)
// ---------------------------------------------------------------------------
function matchesGlob(pattern, value) {
  if (!pattern.includes('*')) return pattern === value;
  // Only handle leading wildcard: *@domain.com
  const suffix = pattern.replace(/^\*/, '');
  return value.endsWith(suffix);
}
function isInAllowlist(allowlist, senderId) {
  return allowlist.some((entry) => matchesGlob(entry, senderId));
}
/**
 * Allowlist-only check: is this sender approved to talk to the bot at all?
 * Mirrors the `senderAllowed` decision inside `checkMessage` (steps 2–3) but
 * exposes it on its own so callers can authorize side-channels (e.g. the
 * clarify correlator) without re-running mention gating or pairing flow.
 */
export function isSenderAllowed(message, config) {
  if (!config) return true; // backward-compat: no platform config means no filter
  if (config.enabled === false) return true; // filter disabled for this platform
  const senderId = message.userId ?? '';
  const allowlist = [];
  if (config.ownerUserId) allowlist.push(config.ownerUserId);
  if (config.recipientAllowlist) allowlist.push(...config.recipientAllowlist);
  if (allowlist.length === 0) return false;
  return isInAllowlist(allowlist, senderId);
}
// ---------------------------------------------------------------------------
// Core filter
// ---------------------------------------------------------------------------
/**
 * Evaluate an inbound message against the per-platform config.
 *
 * Logic order:
 * 0. config.enabled === false → allow (filter explicitly disabled for platform).
 * 1. No platform config → allow (backward compat).
 * 2. Build effective allowlist = [ownerUserId, ...recipientAllowlist].
 * 3. Sender in allowlist → proceed to step 6.
 * 4. Not allowlisted + group → drop.
 * 5. Not allowlisted + DM → apply dmPolicy.
 * 6. Allowlisted + group + no mention → drop (mention gating).
 * 7. Context visibility filter.
 * 8. → allow.
 */
export function checkMessage(message, config, pairingDb) {
  // Step 1: no platform config → backward compat allow
  if (!config) return { action: 'allow' };
  // Step 0: filter explicitly disabled for this platform → allow everything
  if (config.enabled === false) return { action: 'allow' };
  const senderId = message.userId ?? '';
  // Step 2: effective allowlist
  const allowlist = [];
  if (config.ownerUserId) allowlist.push(config.ownerUserId);
  if (config.recipientAllowlist) allowlist.push(...config.recipientAllowlist);
  const senderAllowed = allowlist.length === 0 ? false : isInAllowlist(allowlist, senderId);
  // Step 3 / 4 / 5: allowlist check
  if (!senderAllowed) {
    // Step 4: not allowlisted + group → silent drop
    if (!message.isDm) {
      return { action: 'drop' };
    }
    // Step 5: not allowlisted + DM → apply dmPolicy
    const policy = config.dmPolicy ?? 'pairing';
    switch (policy) {
      case 'allowlist':
      case 'reject':
      case 'silent-drop':
      case 'queue':
        return { action: 'drop' };
      case 'pairing': {
        if (!pairingDb) {
          // No pairing DB wired — fall back to drop
          return { action: 'drop' };
        }
        const code = generateCode(pairingDb, senderId, message.platform);
        if (code === null) {
          // Rate-limited — silently drop; user already got a code recently
          return { action: 'drop' };
        }
        const reply = `To talk with this agent, ask the owner to run: /allow ${code}`;
        return { action: 'pairing_reply', reply };
      }
    }
  }
  // Step 6: allowlisted sender in group without mention → drop (mention gating, 1c)
  // Owner bypasses mention gate — must be able to run /allow from any channel.
  if (!message.isDm && !message.isGroupMention && senderId !== config.ownerUserId) {
    return { action: 'drop' };
  }
  // Step 7: context visibility filter (1d)
  // Only strip when replyToUserId is explicitly set AND non-allowlisted.
  // If replyToUserId is absent (adapter can't provide it), do not strip.
  const visibility = config.contextVisibility ?? 'all';
  if (
    (visibility === 'allowlist' || visibility === 'allowlist_quote') &&
    message.replyToId !== undefined &&
    message.replyToUserId !== undefined
  ) {
    const replyAllowed = isInAllowlist(allowlist, message.replyToUserId);
    if (!replyAllowed) {
      const stripped =
        '[quoted content from non-allowlisted sender removed]\n' +
        message.text.replace(/^>.*\n?/gm, '').trim();
      return { action: 'allow', strippedText: stripped };
    }
  }
  // Step 8: allow
  return { action: 'allow' };
}
