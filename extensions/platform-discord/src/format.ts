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

/**
 * HTML element names the model might emit. Only these are stripped: anything
 * else between `<` and `>` is text — generics (`Map<string, number[]>`),
 * comparisons (`x < 5 and y > 3`), or Discord's own syntax (`<@id>`, `<#id>`,
 * `<t:…>`, `<https://…>`). Pings stay neutralised by `allowedMentions:
 * { parse: [] }` on every send, not by this formatter (`DiscordAdapter.send`).
 */
const HTML_TAG =
  /<\/?(?:a|abbr|b|blockquote|br|code|del|div|em|h[1-6]|hr|i|img|ins|kbd|li|mark|ol|p|pre|s|small|span|strike|strong|sub|sup|table|tbody|td|th|thead|tr|u|ul)(?:\s[^<>]*)?\/?>/gi;

/**
 * UBP-013 — fenced blocks and inline code are set aside before either rewrite
 * runs and restored after, so code reaches Discord byte for byte. Pinned by
 * `__tests__/format.test.ts`.
 */
export function toNativeMarkdown(text: string): string {
  const code: string[] = [];
  // A private-use U+E000 the model wrote would be read back as a placeholder; drop it.
  let out = text
    .replace(/\uE000/g, '')
    .replace(/```[\s\S]*?```|`[^`\n]+`/g, (span) => `\uE000${code.push(span) - 1}\uE000`);

  // Strip real HTML tags — Discord renders raw markdown, not HTML
  out = out.replace(HTML_TAG, '');

  // Links: [text](url) → text (url)  — Discord plain text doesn't support markdown links
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');

  return out.replace(/\uE000(\d+)\uE000/g, (_m, i: string) => code[Number(i)] ?? '');
}
