import type { ContextAnatomyWire } from '@ethosagent/web-contracts';
import { formatContextTokens } from './format-context-tokens';

export interface AnatomyRow {
  key: 'system' | 'memory' | 'skills' | 'tools' | 'messages';
  label: string;
  tokens: number;
  /** Memory/skills are an estimate by size share of the system prompt. */
  approx: boolean;
}

/** The five context rows, System net of the memory and skills carved out of it. */
export function contextAnatomyRows(a: ContextAnatomyWire): AnatomyRow[] {
  return [
    {
      key: 'system',
      label: 'System',
      tokens: Math.max(0, a.system - a.memory - a.skills),
      approx: false,
    },
    { key: 'memory', label: 'Memory', tokens: a.memory, approx: true },
    { key: 'skills', label: 'Skills', tokens: a.skills, approx: true },
    { key: 'tools', label: 'Tool schemas', tokens: a.tools, approx: false },
    { key: 'messages', label: 'Messages', tokens: a.messages, approx: false },
  ];
}

/** `200000` → `200K` (window sizes read in capitals, unlike the composer's `12.4k`). */
export function formatWindow(n: number): string {
  return formatContextTokens(n).replace(/k$/, 'K');
}
