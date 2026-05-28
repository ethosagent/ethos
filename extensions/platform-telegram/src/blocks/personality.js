/**
 * Telegram character sheet card — the `/personality rich` rendering for
 * Telegram. Mirrors the Slack `personalityRichBlocks` but outputs plain
 * Markdown text instead of Block Kit. Same redactions as Slack: fs_reach,
 * MCP servers, and plugins are omitted.
 */
import { escapeHtml } from '../format';
// Per-section caps so one field can't blow past Telegram's 4096-char limit.
const TOOLS_MAX = 1200;
const SKILLS_MAX = 1200;
const TOTAL_MAX = 4096;
function truncate(text, limit) {
    if (text.length <= limit)
        return text;
    return `${text.slice(0, limit - 1)}…`;
}
export function personalityRichMessage(card, opts) {
    const html = opts?.mode === 'html';
    const b = (t) => (html ? `<b>${t}</b>` : `*${t}*`);
    const i = (t) => (html ? `<i>${t}</i>` : `_${t}_`);
    const code = (t) => (html ? `<code>${t}</code>` : `\`${t}\``);
    /** Escape user-supplied text for the active mode. HTML mode escapes the
     *  five HTML-special characters; Markdown mode is plain (Telegram's
     *  MarkdownV2 parsing is opt-in and we don't enable it here). */
    const esc = (t) => (html ? escapeHtml(t) : t);
    const lines = [];
    // Header
    lines.push(b(esc(card.name)));
    lines.push('');
    // Identity — description plus the personality's own SOUL.md voice.
    if (card.description)
        lines.push(esc(card.description));
    if (card.prose)
        lines.push(i(esc(card.prose)));
    if (card.description || card.prose)
        lines.push('');
    // Routing
    lines.push(`${b('Runs on:')} ${esc(card.model)} via ${esc(card.provider)}`);
    lines.push(`${b('Remembers:')} MEMORY.md, USER.md`);
    lines.push('');
    // Tools
    const toolCount = card.toolset.length;
    const toolLabel = `${b('What it can do')} — ${toolCount} tool${toolCount === 1 ? '' : 's'}`;
    if (toolCount > 0) {
        const toolList = truncate(card.toolset.map((t) => code(esc(t))).join(', '), TOOLS_MAX);
        lines.push(toolLabel);
        lines.push(toolList);
    }
    else {
        lines.push(toolLabel);
        lines.push(i('No tools — this personality can only converse.'));
    }
    lines.push('');
    // Skills
    const skillCount = card.skills.length;
    const skillLabel = `${b('What it knows')} — ${skillCount} skill${skillCount === 1 ? '' : 's'}`;
    if (skillCount > 0) {
        const skillList = truncate(card.skills.map((s) => `${code(esc(s.id))} (${s.source})`).join('\n'), SKILLS_MAX);
        lines.push(skillLabel);
        lines.push(skillList);
    }
    else {
        lines.push(skillLabel);
        lines.push(i('No skills resolved for this personality.'));
    }
    const result = lines.join('\n');
    return truncate(result, TOTAL_MAX);
}
