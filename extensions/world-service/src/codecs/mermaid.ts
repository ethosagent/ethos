// Mermaid `graph LR` export for docs. Node ids are positional (`n0`, `n1`...)
// so source ids never reach the syntax; labels escape every character Mermaid
// treats as syntax using its `#<code>;` entity form. Pinned by
// __tests__/exports.test.ts 'Mermaid escapes quotes and brackets' and
// 'Mermaid caps at 200 nodes with a truncated note'.

import type { GraphBundle } from '@ethosagent/types';

export const MERMAID_MAX_NODES = 200;

const ENTITY: Record<string, string> = {
  '#': '#35;',
  '"': '#quot;',
  '[': '#91;',
  ']': '#93;',
  '(': '#40;',
  ')': '#41;',
  '{': '#123;',
  '}': '#125;',
  '<': '#lt;',
  '>': '#gt;',
  '|': '#124;',
  ';': '#59;',
  '`': '#96;',
  '\\': '#92;',
};

function label(s: string): string {
  return s.replace(/[\r\n\t]+/g, ' ').replace(/[#"[\](){}<>|;`\\]/g, (c) => ENTITY[c] ?? c);
}

/** Entities are taken in id order; edges between kept nodes only. */
export function toMermaid(bundle: GraphBundle): string {
  const sorted = [...bundle.entities].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const kept = sorted.slice(0, MERMAID_MAX_NODES);
  const ids = new Map(kept.map((e, i) => [e.id, `n${i}`]));
  const lines = ['graph LR'];
  for (const e of kept) lines.push(`  ${ids.get(e.id)}["${label(e.name)}"]`);
  for (const e of bundle.edges) {
    const from = ids.get(e.fromId);
    const to = ids.get(e.toId);
    if (from && to) lines.push(`  ${from} -->|"${label(e.type)}"| ${to}`);
  }
  if (sorted.length > kept.length) {
    lines.push(`%% truncated: showing ${kept.length} of ${sorted.length} nodes`);
  }
  return `${lines.join('\n')}\n`;
}
