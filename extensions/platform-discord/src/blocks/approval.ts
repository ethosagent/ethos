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

function formatArgs(args: unknown): string {
  let text: string;
  if (args === null || args === undefined) {
    text = '(no arguments)';
  } else if (typeof args === 'string') {
    text = args;
  } else {
    try {
      text = JSON.stringify(args, null, 2);
    } catch {
      text = String(args);
    }
  }
  text = text.replace(/`{3,}/g, (run) => run.split('').join('​'));
  if (text.length > ARGS_PREVIEW_MAX) {
    return `${text.slice(0, ARGS_PREVIEW_MAX)}\n… (truncated)`;
  }
  return text;
}
