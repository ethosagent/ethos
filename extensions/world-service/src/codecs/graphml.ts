// GraphML export for Gephi / yEd. Every text and attribute value goes through
// `xmlText`, which escapes the five XML entities and drops characters XML 1.0
// forbids; pinned by __tests__/exports.test.ts 'GraphML is well-formed XML
// with escaped names'. Pass a sliceBundle() result for a single time slice.

import type { GraphBundle } from '@ethosagent/types';

// Characters outside the XML 1.0 Char production.
// biome-ignore lint/suspicious/noControlCharactersInRegex: that is the point
const INVALID_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;

function xmlText(s: string): string {
  return s
    .replace(INVALID_XML, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const NODE_KEYS = [
  ['type', 'string'],
  ['name', 'string'],
  ['aliases', 'string'],
  ['recordedAt', 'string'],
  ['retiredAt', 'string'],
  ['author', 'string'],
  ['sourceRef', 'string'],
] as const;

const EDGE_KEYS = [
  ['type', 'string'],
  ['validFrom', 'string'],
  ['validTo', 'string'],
  ['recordedAt', 'string'],
  ['retiredAt', 'string'],
  ['author', 'string'],
  ['sourceRef', 'string'],
  ['confidence', 'double'],
] as const;

function data(prefix: 'n' | 'e', key: string, value: string | number | null): string {
  if (value === null) return '';
  return `      <data key="${prefix}_${key}">${xmlText(String(value))}</data>\n`;
}

export function toGraphML(bundle: GraphBundle): string {
  const out: string[] = ['<?xml version="1.0" encoding="UTF-8"?>\n'];
  out.push('<graphml xmlns="http://graphml.graphdrawing.org/xmlns">\n');
  for (const [k, t] of NODE_KEYS) {
    out.push(`  <key id="n_${k}" for="node" attr.name="${k}" attr.type="${t}"/>\n`);
  }
  for (const [k, t] of EDGE_KEYS) {
    out.push(`  <key id="e_${k}" for="edge" attr.name="${k}" attr.type="${t}"/>\n`);
  }
  out.push('  <graph id="G" edgedefault="directed">\n');
  for (const e of bundle.entities) {
    out.push(`    <node id="${xmlText(e.id)}">\n`);
    out.push(data('n', 'type', e.type), data('n', 'name', e.name));
    out.push(data('n', 'aliases', e.aliases.join(', ')));
    out.push(data('n', 'recordedAt', e.recordedAt), data('n', 'retiredAt', e.retiredAt));
    out.push(data('n', 'author', e.author), data('n', 'sourceRef', e.sourceRef));
    out.push('    </node>\n');
  }
  for (const e of bundle.edges) {
    out.push(
      `    <edge id="${xmlText(e.id)}" source="${xmlText(e.fromId)}" target="${xmlText(e.toId)}">\n`,
    );
    out.push(data('e', 'type', e.type));
    out.push(data('e', 'validFrom', e.validFrom), data('e', 'validTo', e.validTo));
    out.push(data('e', 'recordedAt', e.recordedAt), data('e', 'retiredAt', e.retiredAt));
    out.push(data('e', 'author', e.author), data('e', 'sourceRef', e.sourceRef));
    out.push(data('e', 'confidence', e.confidence));
    out.push('    </edge>\n');
  }
  out.push('  </graph>\n</graphml>\n');
  return out.join('');
}
