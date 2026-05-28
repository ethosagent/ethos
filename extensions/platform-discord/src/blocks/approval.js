import { actionRow, button, embed, escapeMarkdown, truncate, } from './shared';
export const APPROVE_CUSTOM_ID_PREFIX = 'ethos:approve:';
export const DENY_CUSTOM_ID_PREFIX = 'ethos:deny:';
const ARGS_PREVIEW_MAX = 2500;
export function approvalPendingEmbed(input) {
    const desc = [`\`${escapeMarkdown(input.toolName)}\` wants to run.`];
    if (input.reason) {
        desc.push(`**Why:** ${escapeMarkdown(input.reason)}`);
    }
    desc.push(`\`\`\`json\n${formatArgs(input.args)}\n\`\`\``);
    return embed({ title: 'Approval Required', description: truncate(desc.join('\n\n'), 4096) });
}
export function approvalPendingButtons(approvalId) {
    return actionRow(button('Allow', `${APPROVE_CUSTOM_ID_PREFIX}${approvalId}`, 3), button('Deny', `${DENY_CUSTOM_ID_PREFIX}${approvalId}`, 4));
}
export function approvalResolvedEmbed(input) {
    const verb = input.decision === 'allow' ? 'Approved' : 'Denied';
    return embed({
        title: verb,
        description: `\`${escapeMarkdown(input.toolName)}\` — ${verb.toLowerCase()} by ${escapeMarkdown(input.decidedBy)}`,
    });
}
function formatArgs(args) {
    let text;
    if (args === null || args === undefined) {
        text = '(no arguments)';
    }
    else if (typeof args === 'string') {
        text = args;
    }
    else {
        try {
            text = JSON.stringify(args, null, 2);
        }
        catch {
            text = String(args);
        }
    }
    text = text.replace(/`{3,}/g, (run) => run.split('').join('​'));
    if (text.length > ARGS_PREVIEW_MAX) {
        return `${text.slice(0, ARGS_PREVIEW_MAX)}\n… (truncated)`;
    }
    return text;
}
