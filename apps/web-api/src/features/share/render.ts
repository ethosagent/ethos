import { createHash } from 'node:crypto';
import type { ShareSnapshotWire } from '@ethosagent/web-contracts';

// Server-rendered public share page (plan share-links §3 Public page, D1, D5, D6).
// Pure: same input, same string. Guarantees, each pinned by
// __tests__/render-share-page.test.ts and ../../__tests__/routes/share-route.test.ts:
// - every dynamic value passes `escapeHtml` (& < > " '); there is no markdown, no link,
//   no image and no script, so transcript text is inert;
// - text is shown with `white-space: pre-wrap`;
// - tool names render as chips, with an error flag, only when the snapshot carries them;
// - the only inline code is one <style nonce>; fonts are the `'Geist', system-ui` stack
//   and the page loads nothing, so the route's CSP needs no font-src;
// - colours are DESIGN.md tokens with a prefers-color-scheme dark set.

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export const CSS = `:root{--bg:#FAFAF7;--fg:#1A1A1A;--fg2:#585857;--fg3:#70706B;--line:#E8E8E4;--chip:#F0F0EC;--err:#CE2C2C;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--bg:#0F0F0F;--fg:#E8E8E6;--fg2:#9A9A98;--fg3:#7E7E7D;--line:#2A2A2A;--chip:#2A2A2A;--err:#F87171}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:400 14px/1.5 'Geist',system-ui,sans-serif;padding:32px 16px 24px}
.col{max-width:720px;margin:0 auto}
h1{font:600 24px/1.25 'Geist',system-ui,sans-serif;margin:0 0 8px;overflow-wrap:anywhere}
.meta{display:flex;flex-wrap:wrap;gap:2px 16px;color:var(--fg2);font-size:12px;padding-bottom:16px;border-bottom:1px solid var(--line)}
.mono,.chip{font-family:'Geist Mono',ui-monospace,monospace;font-variant-numeric:tabular-nums}
.meta .mono{color:var(--fg)}
.turn{padding:16px 0;border-bottom:1px solid var(--line)}
.who{font:500 11px/1.4 'Geist',system-ui,sans-serif;letter-spacing:.08em;text-transform:uppercase;color:var(--fg3)}
.body{white-space:pre-wrap;overflow-wrap:anywhere;margin:4px 0 0}
.user .body{background:var(--chip);border-radius:4px;padding:8px 12px}
.chip{display:inline-flex;align-items:center;gap:4px;font-size:12px;border:1px solid var(--line);background:var(--chip);color:var(--fg2);border-radius:4px;padding:0 6px;margin:4px 4px 0 0}
.chip.err{color:var(--err);border-color:var(--err)}
footer{margin-top:24px;color:var(--fg3);font-size:12px}
p{margin:0;color:var(--fg2)}`;

export const HEAD = (title: string, styleAttrs: string, extraCss = ''): string =>
  `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)}</title>
<style${styleAttrs}>${CSS}${extraCss}</style>
</head>
<body>
<div class="col">
`;

/** `2026-12-03T14:20:00.000Z` -> `2026-12-03 14:20 UTC`; anything else is shown as given. */
function formatWhen(iso: string): string {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(iso)
    ? `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`
    : iso;
}

export interface RenderShareOptions {
  /** This response's CSP nonce; the one <style> carries it. */
  nonce: string;
  /** The link's expiry, shown beside the creation time. */
  expiresAt: string;
}

export function renderSharePage(snapshot: ShareSnapshotWire, opts: RenderShareOptions): string {
  const assistantLabel = snapshot.personalityId ?? 'Assistant';
  const meta = [
    snapshot.personalityId
      ? `<span>Personality <span class="mono">${escapeHtml(snapshot.personalityId)}</span></span>`
      : '',
    `<span>Created <span class="mono">${escapeHtml(formatWhen(snapshot.createdAt))}</span></span>`,
    `<span>Expires <span class="mono">${escapeHtml(formatWhen(opts.expiresAt))}</span></span>`,
  ].join('\n');
  const turns = snapshot.turns
    .map((turn) => {
      const isUser = turn.role === 'user';
      const chips =
        turn.tools && turn.tools.length > 0
          ? `\n<div>${turn.tools
              .map((t) =>
                t.isError
                  ? `<span class="chip err">&#10007; ${escapeHtml(t.name)}</span>`
                  : `<span class="chip">${escapeHtml(t.name)}</span>`,
              )
              .join('')}</div>`
          : '';
      return `<div class="turn${isUser ? ' user' : ''}">
<div class="who">${isUser ? 'You' : escapeHtml(assistantLabel)}</div>
<div class="body">${escapeHtml(turn.text)}</div>${chips}
</div>`;
    })
    .join('\n');
  return `${HEAD(snapshot.title, ` nonce="${escapeHtml(opts.nonce)}"`)}<h1>${escapeHtml(snapshot.title)}</h1>
<div class="meta">
${meta}
</div>
${turns}
<footer>Read-only snapshot. Redacted at creation.</footer>
</div>
</body>
</html>
`;
}

/**
 * The one 404 every miss returns (bad shape, unknown, revoked, expired, feature off), so a
 * reader cannot tell a revoked link from one that never existed. It carries no nonce: the
 * inline <style> is allowed by hash, so every 404 is byte-identical (share-route.test.ts
 * 'uniform 404').
 */
export const NOT_FOUND_PAGE = {
  html: `${HEAD('Not found', '')}<h1>Not found</h1>
<p>This link doesn't exist or has expired.</p>
</div>
</body>
</html>
`,
  styleHash: `'sha256-${createHash('sha256').update(CSS).digest('base64')}'`,
};
