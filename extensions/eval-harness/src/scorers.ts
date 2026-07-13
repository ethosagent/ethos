import {
  type CompletionOptions,
  type LLMProvider,
  type Message,
  structuredOutputOption,
} from '@ethosagent/types';
import type { EvalExpected } from './types';

export type Scorer = (response: string, expected: EvalExpected) => Promise<number>;

export async function exactMatchScorer(response: string, expected: EvalExpected): Promise<number> {
  return response.trim() === expected.expected.trim() ? 1 : 0;
}

export async function containsScorer(response: string, expected: EvalExpected): Promise<number> {
  return response.toLowerCase().includes(expected.expected.toLowerCase()) ? 1 : 0;
}

export async function regexScorer(response: string, expected: EvalExpected): Promise<number> {
  try {
    return new RegExp(expected.expected, 'i').test(response) ? 1 : 0;
  } catch {
    return 0;
  }
}

// §3 — grammar-constrained verdict shape, used only when the provider declares
// `capabilities.structuredOutput`. Strict + additionalProperties:false so the
// json_schema path is valid on OpenAI-compat servers that enforce it.
const JUDGE_VERDICT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: { meets: { type: 'boolean' } },
  required: ['meets'],
  additionalProperties: false,
};

/** Parse a `{ "meets": boolean }` verdict; null when the text is not that shape. */
function parseJudgeVerdict(text: string): number | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && 'meets' in parsed) {
      return (parsed as { meets: unknown }).meets === true ? 1 : 0;
    }
  } catch {
    // Fall through to the textual fallback.
  }
  return null;
}

export function llmJudgeScorer(llm: LLMProvider): Scorer {
  return async (response: string, expected: EvalExpected): Promise<number> => {
    // §3 — a schema-capable endpoint gets grammar-constrained decoding so the
    // verdict parses without repair. Non-capable endpoints keep the original
    // "reply 1 or 0" prompt + parse, byte-identical to before.
    const capable = llm.capabilities?.structuredOutput === true;
    const instruction = capable
      ? `Criteria: ${expected.expected}\n\nResponse:\n${response}\n\nDoes the response meet the criteria? Reply with a JSON object {"meets": true} or {"meets": false}.`
      : `Criteria: ${expected.expected}\n\nResponse:\n${response}\n\nDoes the response meet the criteria? Reply with only "1" (yes) or "0" (no).`;
    const messages: Message[] = [{ role: 'user', content: instruction }];
    const options: CompletionOptions = capable
      ? {
          maxTokens: 20,
          temperature: 0,
          providerOptions: structuredOutputOption(JUDGE_VERDICT_SCHEMA, { name: 'judge_verdict' }),
        }
      : { maxTokens: 5, temperature: 0 };

    let text = '';
    for await (const chunk of llm.complete(messages, [], options)) {
      if (chunk.type === 'text_delta') text += chunk.text;
    }
    text = text.trim();

    if (capable) {
      const verdict = parseJudgeVerdict(text);
      if (verdict !== null) return verdict;
      // Fall back to the textual parse if a capable model returned prose.
    }
    return text.startsWith('1') ? 1 : 0;
  };
}
