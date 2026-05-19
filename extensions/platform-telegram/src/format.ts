import { createHash } from 'node:crypto';

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
 *   1. Escape raw HTML in ALL text content.
 *   2. Apply markdown→HTML substitutions from most specific to least specific.
 *
 * Covers: **bold**, _italic_, `code`, ```code blocks``` (with optional
 * language tag), ~~strike~~, ||spoiler||, [label](url).
 */
export function markdownToTelegramHtml(text: string): string {
  // Step 1: escape raw HTML so the agent can't inject tags.
  let out = escapeHtml(text);

  // Step 2: code blocks (``` ... ```) — must come before inline code.
  // With optional language tag: ```ts\ncode\n``` → <pre><code class="language-ts">code</code></pre>
  // Without language tag: ```\ncode\n``` → <pre>code</pre>
  out = out.replace(
    /```(\w+)?\n([\s\S]*?)```/g,
    (_match, lang: string | undefined, code: string) => {
      if (lang) {
        return `<pre><code class="language-${lang}">${code}</code></pre>`;
      }
      return `<pre>${code}</pre>`;
    },
  );

  // Step 3: inline code (` ... `) — single backtick pairs.
  out = out.replace(/`([^`\n]+)`/g, '<code>$1</code>');

  // Step 4: bold (**text**)
  out = out.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');

  // Step 5: italic (_text_) — avoid matching inside URLs or already-converted tags.
  // Use word-boundary-aware matching: _text_ but not mid_word_case.
  out = out.replace(/(?<![a-zA-Z0-9])_(.+?)_(?![a-zA-Z0-9])/g, '<i>$1</i>');

  // Step 6: strikethrough (~~text~~)
  out = out.replace(/~~(.+?)~~/g, '<s>$1</s>');

  // Step 7: spoiler (||text||)
  out = out.replace(/\|\|(.+?)\|\|/g, '<tg-spoiler>$1</tg-spoiler>');

  // Step 8: links [label](url) — the URL was already HTML-escaped in step 1,
  // so &amp; in query strings is correct for HTML attributes. Only allow
  // http(s) schemes; strip links with dangerous schemes (javascript:, data:,
  // vbscript:, etc.) by rendering them as plain text.
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label: string, url: string) => {
    if (isSafeUrl(url)) return `<a href="${url}">${label}</a>`;
    return label;
  });

  return out;
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
