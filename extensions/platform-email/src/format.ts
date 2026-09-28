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

/**
 * Render model Markdown as a simple HTML email body.
 *
 * UBP-051 — fenced blocks and inline code are rendered first, from the raw
 * text, into U+E000-delimited placeholders, so none of the emphasis, header,
 * link, list, paragraph or line-break rewrites below can reach inside code.
 * The remaining prose is HTML-escaped before any tag is generated, so a bare
 * `<`/`>` the model wrote is text, never markup. The placeholders are put back
 * last; the paragraph and `<br>` rules treat one as the tag it stands for.
 * Pinned by `__tests__/format-code.test.ts`.
 */
export function toNativeMarkdown(text: string): string {
  const code: string[] = [];
  const stash = (html: string) => `\uE000${code.push(html) - 1}\uE000`;

  // A private-use U+E000 the model wrote would be read back as a placeholder; drop it.
  let out = text.replace(/\uE000/g, '');

  // Fenced code blocks → <pre><code>
  out = out.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, _lang, body: string) =>
    stash(`<pre><code>${escapeHtml(body)}</code></pre>`),
  );

  // Inline code → <code>
  out = out.replace(/`([^`\n]+)`/g, (_m, body: string) =>
    stash(`<code>${escapeHtml(body)}</code>`),
  );

  // Prose: escape before generating any markup.
  out = escapeHtml(out);

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
  if (!/^[<\uE000]/.test(out)) out = `<p>${out}`;
  if (!/[>\uE000]$/.test(out)) out = `${out}</p>`;

  // Single line breaks → <br>
  out = out.replace(/(?<![>\uE000])\n(?![<\uE000])/g, '<br>');

  return out.replace(/\uE000(\d+)\uE000/g, (_m, i: string) => code[Number(i)] ?? '');
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
