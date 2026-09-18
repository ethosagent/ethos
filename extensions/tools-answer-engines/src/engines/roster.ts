import { chatgptEngine } from './chatgpt';
import { perplexityEngine } from './perplexity';
import type { AnswerEngine } from './types';

/** Every engine `engine_ask` can address. A second entry is a file, not a redesign. */
export const ALL_ENGINES: readonly AnswerEngine[] = [chatgptEngine, perplexityEngine];

export function findEngine(id: string): AnswerEngine | undefined {
  return ALL_ENGINES.find((e) => e.id === id);
}
