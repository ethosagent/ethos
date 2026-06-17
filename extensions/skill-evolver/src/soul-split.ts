// Soul split (Phase W1a, Layer 2) — proposes a Core/Expression partition of an
// existing free-prose SOUL.md.
//
// A personality's Core is its immutable identity; its Expression is the mutable
// voice. draftSoulSplit() makes a single LLM call that partitions the EXISTING
// prose into the two halves (it must not invent new identity content), returning
// the proposed Core and Expression plus a one-line rationale. This is a proposal
// a human reviews before saving.

import type { LLMProvider } from '@ethosagent/types';

export interface SoulSplitProposal {
  core: string;
  expression: string;
  rationale: string;
}

const SYSTEM_PROMPT =
  'You partition an existing free-prose SOUL.md into two halves. ' +
  'Core is the immutable identity: who I am, my non-negotiables, my purpose. ' +
  'Expression is the mutable voice: tone, phrasing, response shape. ' +
  'Do not invent new identity content — only partition or lightly rephrase the prose you are given. ' +
  'When unsure whether a sentence is identity or voice, keep it in Core. ' +
  'Output EXACTLY this convention and nothing else:\n' +
  'CORE:\n<core prose>\n\nEXPRESSION:\n<expression prose>\n\nRATIONALE: <one line>';

export async function draftSoulSplit(soulMd: string, llm: LLMProvider): Promise<SoulSplitProposal> {
  const userContent = [
    '## SOUL.md (existing free-prose identity)',
    soulMd,
    '',
    'Partition the prose above into Core and Expression using the required output convention.',
  ].join('\n');

  let text = '';
  for await (const chunk of llm.complete([{ role: 'user', content: userContent }], [], {
    system: SYSTEM_PROMPT,
    maxTokens: 2048,
    temperature: 0.2,
  })) {
    if (chunk.type === 'text_delta') text += chunk.text;
  }

  return parse(text);
}

function parse(text: string): SoulSplitProposal {
  const lines = text.split('\n');

  let hasCoreMarker = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.startsWith('CORE:')) {
      hasCoreMarker = true;
      break;
    }
  }
  if (!hasCoreMarker) {
    return { core: text.trim(), expression: '', rationale: '' };
  }

  const coreBuffer: string[] = [];
  const exprBuffer: string[] = [];
  let rationale = '';
  let section: 'none' | 'core' | 'expression' | 'done' = 'none';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.startsWith('CORE:')) {
      section = 'core';
      const rest = line.slice('CORE:'.length).trim();
      if (rest) coreBuffer.push(rest);
      continue;
    }
    if (line.startsWith('EXPRESSION:')) {
      section = 'expression';
      const rest = line.slice('EXPRESSION:'.length).trim();
      if (rest) exprBuffer.push(rest);
      continue;
    }
    if (line.startsWith('RATIONALE:')) {
      rationale = line.slice('RATIONALE:'.length).trim();
      section = 'done';
      continue;
    }
    if (section === 'core') coreBuffer.push(line);
    else if (section === 'expression') exprBuffer.push(line);
  }

  return {
    core: coreBuffer.join('\n').trim(),
    expression: exprBuffer.join('\n').trim(),
    rationale: rationale.trim(),
  };
}
