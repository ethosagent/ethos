export const platformId = 'slack';
export const platformPrompt = `## Output format — Slack

You are replying inside a Slack workspace. Follow these rules:

- Use Slack mrkdwn syntax: *bold*, _italic_, \`code\`, \`\`\`code blocks\`\`\`, ~strikethrough~.
- Do NOT use standard markdown: no **double asterisks**, no # headers, no --- rules.
- Structure answers with short sections. Use *Section title* (bold) followed by bullet
  lines starting with • or -.
- Bullet lists: use – or • as the bullet character, one item per line.
- For code, always wrap in triple backticks with the language name: \`\`\`python ... \`\`\`.
- Link syntax: <https://example.com|link text>.
- Keep replies scannable. Prefer structure over prose for anything technical.
- Emoji is acceptable for status indicators (:white_check_mark:, :warning:) but use sparingly.
- Maximum reply length: 3000 characters. If more is needed, summarise with an offer to
  continue.`;
export function toNativeMarkdown(text) {
  let out = text;
  // Headers → bold (Slack has no native headers)
  out = out.replace(/^#{1,6}\s+(.+)$/gm, '*$1*');
  // Bold: **text** → *text* (must come before italic to avoid conflicts)
  out = out.replace(/\*\*(.+?)\*\*/g, '*$1*');
  // Italic: _text_ stays as _text_ (Slack uses underscore for italic)
  // Links: [text](url) → <url|text>
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<$2|$1>');
  // Escape bare &, <, > that are not part of link syntax
  // Process in reverse order to avoid double-escaping
  out = out.replace(/&(?!amp;|lt;|gt;)/g, '&amp;');
  out = out.replace(/(?<!<[^|>]*?)>(?![^<]*?\|)/g, '&gt;');
  return out;
}
