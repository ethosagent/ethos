import type { ChannelCapabilities, PlatformAdapter } from './platform';

// ---------------------------------------------------------------------------
// Channel conformance utilities
//
// Exported so plugin/adapter authors can run the same checks in their own
// test suites. These are pure functions with no side-effects.
// ---------------------------------------------------------------------------

export interface CapsHonestyResult {
  ok: boolean;
  violations: string[];
}

/**
 * Checks that an adapter's declared `caps` are backed by the corresponding
 * optional methods. Returns a list of violations — empty means the adapter
 * is honest about what it can do.
 *
 * Adapters without `caps` are considered compliant (no enforcement applies
 * until they opt in to the Channel SDK contract).
 */
export function assertCapsHonesty(adapter: PlatformAdapter): CapsHonestyResult {
  const violations: string[] = [];
  const caps = adapter.caps;
  if (!caps) return { ok: true, violations };

  if (caps.edit && !adapter.editMessage)
    violations.push('caps.edit is true but editMessage is missing');
  if (caps.typing && !adapter.sendTyping)
    violations.push('caps.typing is true but sendTyping is missing');
  if (caps.slashCommands && !adapter.registerCommands)
    violations.push('caps.slashCommands is true but registerCommands is missing');

  return { ok: violations.length === 0, violations };
}

/**
 * Returns a default all-false `ChannelCapabilities` object at contractVersion 1.
 * Adapter authors can spread from this to declare only the capabilities they
 * actually support:
 *
 * ```ts
 * caps: { ...defaultChannelCapabilities(), edit: true }
 * ```
 */
export function defaultChannelCapabilities(): ChannelCapabilities {
  return {
    media: { imagesIn: false, filesIn: false, imagesOut: false, filesOut: false },
    voice: { transcribeIn: false, ttsOut: false },
    threads: false,
    reactions: { in: false, out: false },
    edit: false,
    delete: false,
    typing: false,
    readReceipts: false,
    approvalButtons: false,
    slashCommands: false,
    mentions: false,
    ephemeral: false,
    multiAccount: false,
    contractVersion: 1,
  };
}
