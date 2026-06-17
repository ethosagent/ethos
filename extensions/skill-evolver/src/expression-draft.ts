// Expression draft (Phase 3a, Layer 2) — proposes a Living Soul Expression update.
//
// A personality's Core is immutable; only its Expression (voice/tone/
// response-shape) evolves. draftExpressionUpdate() makes a single LLM call
// that rewrites the Expression against recent evidence while holding Core
// fixed, returning the new prose plus a one-line rationale.

import type { LLMProvider } from '@ethosagent/types';

export interface ExpressionDraftInput {
  core: string;
  currentExpression: string;
  evidence: string;
}

export interface ExpressionDraft {
  newExpression: string;
  rationale: string;
}

const SYSTEM_PROMPT =
  'You refine a personality Expression (its voice, tone, and response shape). ' +
  'The Core has NOT changed and must not change — only the Expression is being updated. ' +
  'Stay true to the Core; rewrite only how the personality speaks. ' +
  'After the new Expression, on its own final line, write `RATIONALE: <one line explaining the change>`. ' +
  'Output nothing else.';

export async function draftExpressionUpdate(
  input: ExpressionDraftInput,
  llm: LLMProvider,
): Promise<ExpressionDraft> {
  const userContent = [
    '## Core (immutable — do not edit, for alignment only)',
    input.core,
    '',
    '## Current Expression',
    input.currentExpression,
    '',
    '## Evidence (recent interactions)',
    input.evidence,
    '',
    'Rewrite the Expression so it better fits the evidence while staying true to Core. Then add the RATIONALE line.',
  ].join('\n');

  let text = '';
  for await (const chunk of llm.complete([{ role: 'user', content: userContent }], [], {
    system: SYSTEM_PROMPT,
    maxTokens: 1024,
    temperature: 0.4,
  })) {
    if (chunk.type === 'text_delta') text += chunk.text;
  }

  const lines = text.split('\n');
  let rationale = '';
  let cutIndex = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? '';
    if (line.startsWith('RATIONALE:')) {
      rationale = line.slice('RATIONALE:'.length).trim();
      cutIndex = i;
      break;
    }
  }
  const newExpression = lines.slice(0, cutIndex).join('\n').trim();
  return { newExpression, rationale };
}
