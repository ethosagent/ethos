// `personalities.characterSheet` returns the Markdown `ethos personality show`
// prints (`renderCharacterSheet`, extensions/personalities/src/character-sheet.ts).
// The phone renders it as read-only key/value groups (§5, D12): one group per
// `##`/`###` heading, one row per bullet or table row. The title and the prose
// above the first heading are the hero's job, so they are dropped here.

export interface KvRow {
  /** `Model` for `- Model: x`; null for a bare bullet (`- read_file`) or a note line. */
  key: string | null;
  value: string;
  /** Indented sub-bullets under this row (`    - comp: 12 tokens`). */
  detail: string[];
}

export interface KvGroup {
  title: string;
  /** Toolset renders as chips, every other group as rows. */
  kind: 'rows' | 'chips';
  /** Empty means "render `None.`" — a `(none)` bullet counts as nothing. */
  rows: KvRow[];
}

const NONE = /^\(none\)$/i;
const CHIP_GROUPS = new Set(['Toolset']);

function parseBullet(text: string): KvRow {
  const colon = text.indexOf(': ');
  // A key is a short label, not a sentence that happens to contain a colon.
  if (colon > 0 && colon <= 40 && !text.slice(0, colon).includes('`')) {
    return { key: text.slice(0, colon).trim(), value: text.slice(colon + 2).trim(), detail: [] };
  }
  return { key: null, value: text.trim(), detail: [] };
}

function tableCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());
}

export function sheetGroups(markdown: string): KvGroup[] {
  const groups: KvGroup[] = [];
  let current: KvGroup | null = null;
  let tableHeaderSeen = false;
  for (const raw of markdown.split('\n')) {
    const heading = /^#{2,3}\s+(.+)$/.exec(raw);
    if (heading) {
      const title = heading[1]?.trim() ?? '';
      current = { title, kind: CHIP_GROUPS.has(title) ? 'chips' : 'rows', rows: [] };
      groups.push(current);
      tableHeaderSeen = false;
      continue;
    }
    if (!current || raw.trim() === '') continue;
    const sub = /^\s{2,}-\s+(.+)$/.exec(raw);
    if (sub) {
      const last = current.rows[current.rows.length - 1];
      if (last) last.detail.push(sub[1]?.trim() ?? '');
      else current.rows.push({ key: null, value: sub[1]?.trim() ?? '', detail: [] });
      continue;
    }
    const bullet = /^-\s+(.+)$/.exec(raw);
    if (bullet) {
      const text = bullet[1] ?? '';
      if (!NONE.test(text.trim())) current.rows.push(parseBullet(text));
      continue;
    }
    if (raw.trim().startsWith('|')) {
      if (/^\|[\s|:-]+\|$/.test(raw.trim())) continue; // separator
      if (!tableHeaderSeen) {
        tableHeaderSeen = true; // header row names the columns, not a row
        continue;
      }
      const [key = '', ...rest] = tableCells(raw);
      current.rows.push({ key, value: rest.filter(Boolean).join(' · '), detail: [] });
      continue;
    }
    // A count line (`12 tools:`) restates the rows beneath it.
    if (/^\d+ tools?:$/.test(raw.trim())) continue;
    current.rows.push({ key: null, value: raw.trim(), detail: [] });
  }
  return groups;
}
