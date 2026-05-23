export const platformId = 'email';

export const platformPrompt = `## Output format — Email

You are composing an email reply. Follow these rules:

- Write in clear, professional prose. Full sentences, no bullet soup.
- Use short paragraphs (3–5 sentences each). One blank line between paragraphs.
- Bullet lists are acceptable for 4+ parallel items but prefer prose for 1–3 items.
- No markdown syntax — the email will be rendered as plain text or simple HTML. Do not use
  **, __, ##, or backticks.
- Use plain emphasis by word choice, not formatting symbols.
- Start with a direct answer or acknowledgement. End with a clear next step or sign-off.
- Keep length proportional to the question. Short question → short reply. Avoid padding.
- Do not include "Subject:" or "From:" headers. Reply body only.`;

export function toNativeMarkdown(text: string): string {
  let out = text;

  // Fenced code blocks → <pre><code>
  out = out.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, _lang, code) => {
    return `<pre><code>${escapeHtml(code)}</code></pre>`;
  });

  // Inline code → <code>
  out = out.replace(/`([^`\n]+)`/g, (_m, code) => `<code>${escapeHtml(code)}</code>`);

  // Bold: **text** → <strong>text</strong>
  out = out.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

  // Italic: *text* or _text_ → <em>text</em>
  out = out.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>');
  out = out.replace(/(?<![a-zA-Z0-9])_(.+?)_(?![a-zA-Z0-9])/g, '<em>$1</em>');

  // Headers
  out = out.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  out = out.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  out = out.replace(/^# (.+)$/gm, '<h1>$1</h1>');

  // Links: [text](url) → <a href="url">text</a>
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // Unordered list items: - item or * item → <li>item</li>
  // Group consecutive list items into <ul>
  out = out.replace(/(?:^[*-] .+$\n?)+/gm, (block) => {
    const items = block
      .trim()
      .split('\n')
      .map((line) => `<li>${line.replace(/^[*-] /, '')}</li>`)
      .join('');
    return `<ul>${items}</ul>`;
  });

  // Paragraphs: double newlines → <p> wrapping
  out = out.replace(/\n{2,}/g, '</p><p>');
  if (!out.startsWith('<')) out = `<p>${out}`;
  if (!out.endsWith('>')) out = `${out}</p>`;

  // Single line breaks → <br>
  out = out.replace(/(?<!>)\n(?!<)/g, '<br>');

  return out;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
