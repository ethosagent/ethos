import type { InboundMessage } from '@ethosagent/types';
import type Database from 'better-sqlite3';
import { generateCode } from './pairing-store';

// ---------------------------------------------------------------------------
// Config interfaces
// ---------------------------------------------------------------------------

export interface ChannelPlatformConfig {
  /** Owner user ID — always allowed, immutable. */
  ownerUserId?: string;
  /** Additional allowed senders (user IDs or email globs). */
  recipientAllowlist?: string[];
  /**
   * Policy for DMs from non-allowlisted senders.
   * Applies only to DMs; group messages always use allowlist check only.
   */
  dmPolicy?: 'pairing' | 'allowlist' | 'queue' | 'reject' | 'silent-drop';
  /**
   * Context visibility filter.
   * 'all' (default): pass everything through.
   * 'allowlist': strip quoted/threaded content from non-allowlisted senders.
   * 'allowlist_quote': alias for 'allowlist'.
   */
  contextVisibility?: 'all' | 'allowlist' | 'allowlist_quote';
}

/** Full config — keyed by platform name (e.g. 'telegram', 'discord', 'email'). */
export type ChannelFilterConfig = Record<string, ChannelPlatformConfig>;

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export interface ChannelFilterResult {
  action: 'allow' | 'drop' | 'pairing_reply';
  /** The reply text to send when action === 'pairing_reply'. */
  reply?: string;
  /** When set, the caller should use this text instead of message.text. */
  strippedText?: string;
}

// ---------------------------------------------------------------------------
// Glob matching (email only — simple suffix match for *@domain.com)
// ---------------------------------------------------------------------------

function matchesGlob(pattern: string, value: string): boolean {
  if (!pattern.includes('*')) return pattern === value;
  // Only handle leading wildcard: *@domain.com
  const suffix = pattern.replace(/^\*/, '');
  return value.endsWith(suffix);
}

function isInAllowlist(allowlist: string[], senderId: string): boolean {
  return allowlist.some((entry) => matchesGlob(entry, senderId));
}

/**
 * Allowlist-only check: is this sender approved to talk to the bot at all?
 * Mirrors the `senderAllowed` decision inside `checkMessage` (steps 2–3) but
 * exposes it on its own so callers can authorize side-channels (e.g. the
 * clarify correlator) without re-running mention gating or pairing flow.
 */
export function isSenderAllowed(
  message: InboundMessage,
  config: ChannelPlatformConfig | undefined,
): boolean {
  if (!config) return true; // backward-compat: no platform config means no filter
  const senderId = message.userId ?? '';
  const allowlist: string[] = [];
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
 * 1. No platform config → allow (backward compat).
 * 2. Build effective allowlist = [ownerUserId, ...recipientAllowlist].
 * 3. Sender in allowlist → proceed to step 6.
 * 4. Not allowlisted + group → drop.
 * 5. Not allowlisted + DM → apply dmPolicy.
 * 6. Allowlisted + group + no mention → drop (mention gating).
 * 7. Context visibility filter.
 * 8. → allow.
 */
export function checkMessage(
  message: InboundMessage,
  config: ChannelPlatformConfig | undefined,
  pairingDb?: Database.Database,
): ChannelFilterResult {
  // Step 1: no platform config → backward compat allow
  if (!config) return { action: 'allow' };

  const senderId = message.userId ?? '';

  // Step 2: effective allowlist
  const allowlist: string[] = [];
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
