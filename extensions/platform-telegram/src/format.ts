import { createHash } from 'node:crypto';

export const platformId = 'telegram';

export const platformPrompt = `## Output format — Telegram

You are replying inside a Telegram chat. Follow these rules:

- Write in short paragraphs (2–4 sentences). Never write walls of text.
- Use plain Telegram MarkdownV2 syntax: *bold*, _italic_, \`inline code\`, \`\`\`code blocks\`\`\`.
- Escape special characters: . ! ( ) - = # + with a leading backslash when they appear
  outside markdown constructs.
- Use bullet lists (–) for 3+ items. Never use numbered lists unless order genuinely matters.
- No HTML tags. No horizontal rules. No headers (##, ###).
- For structured data (tables, comparisons) prefer compact bullet summaries.
- Keep total reply length under 800 characters for simple questions; up to 2000 for
  technical answers. Split into follow-up messages rather than dumping a wall at once.
- End with a clear statement or question. Never trail off.`;

export const toNativeMarkdown = markdownToTelegramHtml;

// ---------------------------------------------------------------------------
// Markdown → Telegram HTML translator
//
// The agent emits Markdown; Telegram's HTML parse mode requires translation.
// All text content is HTML-escaped BEFORE markdown patterns are applied so
// the agent cannot inject raw HTML.
// ---------------------------------------------------------------------------

/**
 * Escape the five HTML-special characters so raw text can be safely embedded
 * in Telegram HTML. Applied to ALL text content before markdown conversion.
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

/**
 * Convert Markdown formatting to Telegram-compatible HTML.
 *
 * Order of operations:
 *   1. Pull fenced blocks, then inline code spans, out of the RAW text into
 *      placeholders, rendering each as `<pre>`/`<code>` around its
 *      HTML-escaped content. Nothing below ever sees code, so no emphasis tag
 *      lands inside `<pre>`/`<code>` — Telegram's HTML parser rejects that
 *      nesting and the whole chunk would fall back to plain text (UBP-051).
 *   2. Escape raw HTML in the remaining prose.
 *   3. Apply markdown→HTML substitutions from most specific to least specific.
 *   4. Put the rendered code back.
 *
 * Covers: **bold**, _italic_, `code`, ```code blocks``` (with optional
 * language tag), ~~strike~~, ||spoiler||, [label](url). Pinned by
 * `__tests__/format-code.test.ts` and `__tests__/phase4.test.ts`.
 */
export function markdownToTelegramHtml(text: string): string {
  const code: string[] = [];
  const stash = (html: string) => `\uE000${code.push(html) - 1}\uE000`;

  // Step 1: code blocks (``` ... ```) — must come before inline code.
  // With optional language tag: ```ts\ncode\n``` → <pre><code class="language-ts">code</code></pre>
  // Without language tag: ```\ncode\n``` → <pre>code</pre>
  // A private-use U+E000 the model wrote would be read back as a placeholder; drop it.
  let out = text
    .replace(/\uE000/g, '')
    .replace(/```(\w+)?\n([\s\S]*?)```/g, (_match, lang: string | undefined, body: string) => {
      if (lang) {
        return stash(`<pre><code class="language-${lang}">${escapeHtml(body)}</code></pre>`);
      }
      return stash(`<pre>${escapeHtml(body)}</pre>`);
    });

  // Inline code (` ... `) — single backtick pairs.
  out = out.replace(/`([^`\n]+)`/g, (_match, body: string) =>
    stash(`<code>${escapeHtml(body)}</code>`),
  );

  // Step 2: escape raw HTML so the agent can't inject tags. The placeholders
  // are U+E000-delimited digits, which escaping leaves alone.
  out = escapeHtml(out);

  // Step 3: bold (**text**)
  out = out.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');

  // Italic (_text_) — avoid matching inside URLs or already-converted tags.
  // Use word-boundary-aware matching: _text_ but not mid_word_case.
  out = out.replace(/(?<![a-zA-Z0-9])_(.+?)_(?![a-zA-Z0-9])/g, '<i>$1</i>');

  // Strikethrough (~~text~~)
  out = out.replace(/~~(.+?)~~/g, '<s>$1</s>');

  // Spoiler (||text||)
  out = out.replace(/\|\|(.+?)\|\|/g, '<tg-spoiler>$1</tg-spoiler>');

  // Links [label](url) — the URL was already HTML-escaped in step 2,
  // so &amp; in query strings is correct for HTML attributes. Only allow
  // http(s) schemes; strip links with dangerous schemes (javascript:, data:,
  // vbscript:, etc.) by rendering them as plain text.
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label: string, url: string) => {
    if (isSafeUrl(url)) return `<a href="${url}">${label}</a>`;
    return label;
  });

  // Step 4: restore the rendered code.
  return out.replace(/\uE000(\d+)\uE000/g, (_match, i: string) => code[Number(i)] ?? '');
}

/**
 * Validate that a URL uses a safe scheme (http or https). URLs with other
 * schemes — javascript:, data:, vbscript:, etc. — are rejected. The check
 * operates on already-HTML-escaped text, so `https:` appears as-is but
 * `&amp;` in query strings is fine. Relative URLs (no scheme) and protocol-
 * relative URLs (`//host/path`) are allowed — Telegram resolves them safely.
 */
function isSafeUrl(url: string): boolean {
  // After HTML-escaping, the colon is unescaped, so scheme detection works
  // on the raw escaped string. Match the scheme portion before the first `:`.
  const colonIdx = url.indexOf(':');
  if (colonIdx === -1) return true; // relative URL — no scheme
  const scheme = url.slice(0, colonIdx).toLowerCase();
  return scheme === 'http' || scheme === 'https';
}

/**
 * Compute a short hash of a text chunk for observable fallback logging.
 * Returns the first 8 hex chars of sha256.
 */
export function chunkHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 8);
}
