export const platformId = 'discord';
export const platformPrompt = `## Output format — Discord

You are replying inside a Discord server or DM. Follow these rules:

- Use Discord markdown: **bold**, *italic*, __underline__, ~~strikethrough~~, \`code\`,
  \`\`\`code blocks\`\`\`, > blockquote.
- Use ## and ### headers for multi-section answers. Avoid h1 (#).
- Bullet lists: use - or * one item per line.
- Keep replies concise. Discord readers scroll fast — front-load the key point.
- For code, always specify the language after the opening fence: \`\`\`python.
- Embeds are not available in text replies. Use plain structure instead.
- Maximum reply length: 2000 characters (Discord hard limit). If more is needed, say so and
  offer to continue.
- Avoid @mentions unless explicitly asked to tag someone.`;
export function toNativeMarkdown(text) {
  let out = text;
  // Strip any HTML tags — Discord renders raw markdown, not HTML
  out = out.replace(/<[^>]+>/g, '');
  // Links: [text](url) → text (url)  — Discord plain text doesn't support markdown links
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');
  return out;
}
