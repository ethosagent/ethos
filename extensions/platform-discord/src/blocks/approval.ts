import { formatApprovalArgs } from '@ethosagent/surface-kit';
import {
  actionRow,
  button,
  type DiscordActionRow,
  type DiscordEmbed,
  embed,
  escapeMarkdown,
  truncate,
} from './shared';

export const APPROVE_CUSTOM_ID_PREFIX = 'ethos:approve:';
export const DENY_CUSTOM_ID_PREFIX = 'ethos:deny:';

const ARGS_PREVIEW_MAX = 2500;

export interface ApprovalPendingInput {
  approvalId: string;
  toolName: string;
  reason: string | null;
  args: unknown;
}

export function approvalPendingEmbed(input: ApprovalPendingInput): DiscordEmbed {
  const desc = [`\`${escapeMarkdown(input.toolName)}\` wants to run.`];
  if (input.reason) {
    desc.push(`**Why:** ${escapeMarkdown(input.reason)}`);
  }
  desc.push(`\`\`\`json\n${formatArgs(input.args)}\n\`\`\``);
  return embed({ title: 'Approval Required', description: truncate(desc.join('\n\n'), 4096) });
}

export function approvalPendingButtons(approvalId: string): DiscordActionRow {
  return actionRow(
    button('Allow', `${APPROVE_CUSTOM_ID_PREFIX}${approvalId}`, 3),
    button('Deny', `${DENY_CUSTOM_ID_PREFIX}${approvalId}`, 4),
  );
}

export interface ApprovalResolvedInput {
  toolName: string;
  decision: 'allow' | 'deny';
  decidedBy: string;
}

export function approvalResolvedEmbed(input: ApprovalResolvedInput): DiscordEmbed {
  const verb = input.decision === 'allow' ? 'Approved' : 'Denied';
  return embed({
    title: verb,
    description: `\`${escapeMarkdown(input.toolName)}\` — ${verb.toLowerCase()} by ${escapeMarkdown(input.decidedBy)}`,
  });
}

/**
 * The shared approval-args formatter (`formatApprovalArgs`,
 * @ethosagent/surface-kit — credential redaction, then the cap) with Discord's
 * code-fence hardening. A literal ```` ``` ```` inside args would close the
 * fence the caller wraps this in, letting the rest of the args render as live
 * Discord markup on a privileged approval surface. Runs of three or more
 * backticks are broken up with a zero-width space — the text reads the same,
 * but no substring can be parsed as a fence delimiter.
 */
function formatArgs(args: unknown): string {
  return formatApprovalArgs(args, {
    maxChars: ARGS_PREVIEW_MAX,
    neutralize: (text) => text.replace(/`{3,}/g, (run) => run.split('').join('​')),
  });
}
