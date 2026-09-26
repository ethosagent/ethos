import { chatgptEngine } from './chatgpt';
import { geminiEngine } from './gemini';
import { grokEngine } from './grok';
import { microsoftEngine } from './microsoft';
import { perplexityEngine } from './perplexity';
import type { AnswerEngine } from './types';

/** Every engine `engine_ask` can address. A new entry is a file, not a redesign. */
export const ALL_ENGINES: readonly AnswerEngine[] = [
  chatgptEngine,
  perplexityEngine,
  grokEngine,
  geminiEngine,
  microsoftEngine,
];

export function findEngine(id: string): AnswerEngine | undefined {
  return ALL_ENGINES.find((e) => e.id === id);
}

/**
 * The `capabilities.secrets` entries an engine contributes, derived from
 * `bindable`: a bindable engine grants its whole namespace, because a
 * personality's name is any `SECRET_NAME_RE` string and must fall inside a
 * static allowlist; a non-bindable one grants only the exact refs it reads
 * (`operatorSecretRefs`, else its `defaultSecretRef`).
 */
export function secretGrantsOf(engine: AnswerEngine): readonly string[] {
  if (engine.bindable) return [`${engine.secretPrefix}*`];
  return engine.operatorSecretRefs ?? [engine.defaultSecretRef];
}

/** The `<segment>` of an engine's `providers/<segment>/` prefix. */
export function providerSegmentOf(engine: AnswerEngine): string {
  return engine.secretPrefix.split('/')[1] ?? '';
}
