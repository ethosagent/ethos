// Pure Block Kit builder for the App Home "Recent sessions" section. No Slack
// client, no I/O — `(data) => SlackBlock[]`, testable in isolation.
//
// A session row links to the Ethos web UI when a base URL is supplied. There
// is no configured web-UI base URL in the Slack adapter today; when it's
// absent the row renders as plain text. The wiring layer passes one in via
// `SlackAdapterConfig.webUiBaseUrl` once a deployment has a web UI to link to.
import { context, divider, escapeMrkdwn, header, section, truncate, } from './shared';
/** Per-field cap for session labels. Well under Slack's ~3000-char section
 *  limit so the row stays valid even with the longest label. */
const SESSION_LABEL_MAX = 300;
export function sessionListBlocks(input) {
    if (input.sessions.length === 0) {
        return [header('Recent sessions'), section('No recent sessions for this bot yet.')];
    }
    const blocks = [header('Recent sessions')];
    for (const s of input.sessions) {
        const label = escapeMrkdwn(truncate(s.label, SESSION_LABEL_MAX));
        const link = input.webUiBaseUrl
            ? `<${input.webUiBaseUrl}/sessions/${encodeURIComponent(s.id)}|${label}>`
            : label;
        blocks.push(section(`*${link}*`));
        blocks.push(context([`Last active ${s.lastActivity.toISOString()}`]));
    }
    blocks.push(divider());
    return blocks;
}
