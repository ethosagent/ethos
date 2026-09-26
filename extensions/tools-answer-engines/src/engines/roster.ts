import { chatgptEngine } from './chatgpt';
import { perplexityEngine } from './perplexity';
import type { AnswerEngine } from './types';

/** Every engine `engine_ask` can address. A second entry is a file, not a redesign. */
export const ALL_ENGINES: readonly AnswerEngine[] = [chatgptEngine, perplexityEngine];

export function findEngine(id: string): AnswerEngine | undefined {
  return ALL_ENGINES.find((e) => e.id === id);
}

/**
 * The `capabilities.secrets` entry an engine contributes, derived from
 * `bindable`: a bindable engine grants its whole namespace, because a
 * personality's name is any `SECRET_NAME_RE` string and must fall inside a
 * static allowlist; a non-bindable one grants only its operator-wide ref.
 */
export function secretGrantOf(engine: AnswerEngine): string {
  return engine.bindable ? `${engine.secretPrefix}*` : engine.defaultSecretRef;
}

/** The `<segment>` of an engine's `providers/<segment>/` prefix. */
export function providerSegmentOf(engine: AnswerEngine): string {
  return engine.secretPrefix.split('/')[1] ?? '';
}
