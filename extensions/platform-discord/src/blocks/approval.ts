import { formatApprovalArgs, revealHiddenChars } from '@ethosagent/surface-kit';
import { APPROVAL_NOTE_MAX_CHARS } from '@ethosagent/types';
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
export const DENY_NOTE_CUSTOM_ID_PREFIX = 'ethos:denynote:';
export const APPROVAL_NOTE_INPUT_ID = 'ethos_approval_note_input';

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
    desc.push(`**Why:** ${escapeMarkdown(revealHiddenChars(input.reason).text)}`);
  }
  desc.push(`\`\`\`json\n${formatArgs(input.args)}\n\`\`\``);
  return embed({ title: 'Approval Required', description: truncate(desc.join('\n\n'), 4096) });
}

export function approvalPendingButtons(approvalId: string): DiscordActionRow {
  return actionRow(
    button('Allow', `${APPROVE_CUSTOM_ID_PREFIX}${approvalId}`, 3),
    button('Deny with note…', `${DENY_NOTE_CUSTOM_ID_PREFIX}${approvalId}`, 2),
    button('Deny', `${DENY_CUSTOM_ID_PREFIX}${approvalId}`, 4),
  );
}

/** Modal opened by the "Deny with note…" button; same shape as `clarifyModalPayload` plus `max_length`. */
export function approvalNoteModalPayload(approvalId: string): {
  custom_id: string;
  title: string;
  components: Array<{
    type: 1;
    components: Array<{
      type: 4;
      custom_id: string;
      label: string;
      style: 1 | 2;
      required: boolean;
      max_length?: number;
    }>;
  }>;
} {
  return {
    custom_id: `${DENY_NOTE_CUSTOM_ID_PREFIX}${approvalId}`,
    title: 'Deny and redirect',
    components: [
      {
        type: 1,
        components: [
          {
            type: 4,
            custom_id: APPROVAL_NOTE_INPUT_ID,
            label: 'What should it do instead?',
            style: 2,
            required: true,
            max_length: APPROVAL_NOTE_MAX_CHARS,
          },
        ],
      },
    ],
  };
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
