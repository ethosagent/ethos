import type { WorldSnapshotWire } from '@ethosagent/web-contracts';
import { escapeHtml, HEAD } from './render';

// Server-rendered public page for a world share link (plan world-model 7.6). Pure: same input,
// same string. Guarantees, each pinned by __tests__/render-world-page.test.ts
// ('page renders the tree without scripts that call the API'):
// - no <script>, form, input or button: the page cannot edit or fetch anything, and the
//   route's CSP (`default-src 'none'`, `sandbox`) would refuse it anyway (routes/share.ts);
// - every dynamic value passes `escapeHtml`;
// - entity ids become `id="e-<id>"` anchors and links point at `#e-<id>`, so navigation stays
//   in the page; the only inline code is the one <style nonce>.

const EXTRA_CSS = `
h2{font:600 16px/1.3 'Geist',system-ui,sans-serif;margin:24px 0 8px}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{text-align:left;vertical-align:top;padding:6px 8px;border-bottom:1px solid var(--line);overflow-wrap:anywhere}
th{font:500 11px/1.4 'Geist',system-ui,sans-serif;letter-spacing:.08em;text-transform:uppercase;color:var(--fg3)}
tr:target td{background:var(--chip)}
a{color:var(--fg);text-underline-offset:2px}
nav{margin:12px 0 0;color:var(--fg2);font-size:13px}
nav a{margin-right:12px}
.col{max-width:960px}`;

/** `e-` + the id with anything outside `[A-Za-z0-9_-]` replaced, so it is a valid fragment. */
const anchor = (id: string): string => `e-${id.replace(/[^A-Za-z0-9_-]/g, '_')}`;

const day = (iso: string): string => (/^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : iso);

export interface RenderWorldOptions {
  nonce: string;
  expiresAt: string;
}

export function renderWorldPage(snapshot: WorldSnapshotWire, opts: RenderWorldOptions): string {
  const known = new Set(snapshot.groups.flatMap((g) => g.entities.map((e) => e.id)));
  const ref = (id: string, name: string): string =>
    known.has(id)
      ? `<a href="#${escapeHtml(anchor(id))}">${escapeHtml(name)}</a>`
      : escapeHtml(name);
  const attrs = (list: Array<{ key: string; value: string }>): string =>
    list
      .map(
        (a) => `<div><span class="mono">${escapeHtml(a.key)}</span> ${escapeHtml(a.value)}</div>`,
      )
      .join('');

  const toc = snapshot.groups
    .map(
      (g) =>
        `<a href="#t-${escapeHtml(anchor(g.type))}">${escapeHtml(g.type)} (${g.entities.length})</a>`,
    )
    .join('');
  const sections = snapshot.groups
    .map((g) => {
      const rows = g.entities
        .map((e) => {
          const links = e.links
            .map(
              (l) =>
                `<div>${l.direction === 'out' ? '&rarr;' : '&larr;'} <span class="mono">${escapeHtml(l.type)}</span> ${ref(l.otherId, l.otherName)}</div>`,
            )
            .join('');
          const aliases =
            e.aliases.length > 0
              ? `<div class="mono">${escapeHtml(e.aliases.join(', '))}</div>`
              : '';
          return `<tr id="${escapeHtml(anchor(e.id))}"><td>${escapeHtml(e.name)}${aliases}</td><td>${attrs(e.attrs)}</td><td>${links}</td></tr>`;
        })
        .join('\n');
      return `<h2 id="t-${escapeHtml(anchor(g.type))}">${escapeHtml(g.type)}</h2>
<table>
<thead><tr><th>Name</th><th>Facts</th><th>Relationships</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>`;
    })
    .join('\n');
  const edges =
    snapshot.edges && snapshot.edges.length > 0
      ? `<h2>Relationships</h2>
<table>
<thead><tr><th>From</th><th>Type</th><th>To</th><th>Facts</th></tr></thead>
<tbody>
${snapshot.edges
  .map(
    (e) =>
      `<tr><td>${ref(e.fromId, e.fromName)}</td><td class="mono">${escapeHtml(e.type)}</td><td>${ref(e.toId, e.toName)}</td><td>${attrs(e.attrs)}</td></tr>`,
  )
  .join('\n')}
</tbody>
</table>`
      : '';
  const removed =
    snapshot.redacted.length > 0 ? ` Removed: ${escapeHtml(snapshot.redacted.join(', '))}.` : '';

  return `${HEAD(snapshot.title, ` nonce="${escapeHtml(opts.nonce)}"`, EXTRA_CSS)}<h1>${escapeHtml(snapshot.title)}</h1>
<div class="meta">
<span>World <span class="mono">${escapeHtml(snapshot.world)}</span></span>
<span>View <span class="mono">${escapeHtml(snapshot.view)}</span>, as of <span class="mono">${escapeHtml(day(snapshot.asOf))}</span></span>
<span>Created <span class="mono">${escapeHtml(day(snapshot.createdAt))}</span></span>
<span>Expires <span class="mono">${escapeHtml(day(opts.expiresAt))}</span></span>
</div>
<nav>${toc}</nav>
${sections}
${edges}
<footer>Read-only snapshot, frozen at creation.${removed}</footer>
</div>
</body>
</html>
`;
}
