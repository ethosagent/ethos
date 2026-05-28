export interface SimpleCompletionOptions {
  maxTokens?: number;
  model?: string;
  systemPrompt?: string;
}

export interface SimpleCompletion {
  complete(prompt: string, options?: SimpleCompletionOptions): Promise<string>;
}
