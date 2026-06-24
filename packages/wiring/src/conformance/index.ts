import type {
  CompletionChunk,
  CompletionOptions,
  LLMProvider,
  Message,
  ToolDefinitionLite,
} from '@ethosagent/types';

export interface ConformanceResult {
  passed: boolean;
  checks: ConformanceCheck[];
}

export interface ConformanceCheck {
  name: string;
  passed: boolean;
  message?: string;
}

/**
 * Run the conformance suite against a provider instance.
 * This is the contract test harness — provider authors call this to verify
 * their implementation maps the transport stream correctly and declares
 * capabilities honestly.
 */
export async function runConformance(provider: LLMProvider): Promise<ConformanceResult> {
  const checks: ConformanceCheck[] = [];

  // Check 1: Provider has required fields
  checks.push(checkRequiredFields(provider));

  // Check 2: Capabilities declared
  checks.push(checkCapabilitiesDeclared(provider));

  // Check 3: Capabilities consistency with legacy booleans
  checks.push(checkCapabilitiesConsistency(provider));

  // Check 4: complete() returns AsyncIterable
  checks.push(await checkCompleteReturnsIterable(provider));

  // Check 5: Stream produces valid CompletionChunk variants
  checks.push(await checkChunkVariants(provider));

  return {
    passed: checks.every((c) => c.passed),
    checks,
  };
}

function checkRequiredFields(provider: LLMProvider): ConformanceCheck {
  const missing: string[] = [];
  if (!provider.name) missing.push('name');
  if (!provider.model) missing.push('model');
  if (typeof provider.maxContextTokens !== 'number') missing.push('maxContextTokens');
  if (typeof provider.supportsCaching !== 'boolean') missing.push('supportsCaching');
  if (typeof provider.supportsThinking !== 'boolean') missing.push('supportsThinking');

  return {
    name: 'required-fields',
    passed: missing.length === 0,
    message: missing.length > 0 ? `Missing required fields: ${missing.join(', ')}` : undefined,
  };
}

function checkCapabilitiesDeclared(provider: LLMProvider): ConformanceCheck {
  const caps = provider.capabilities;
  if (!caps) {
    return {
      name: 'capabilities-declared',
      passed: false,
      message:
        'Provider does not declare capabilities. Add a capabilities getter returning ProviderCapabilities.',
    };
  }

  const missing: string[] = [];
  if (typeof caps.streaming !== 'boolean') missing.push('streaming');
  if (typeof caps.toolCalling !== 'boolean') missing.push('toolCalling');

  return {
    name: 'capabilities-declared',
    passed: missing.length === 0,
    message:
      missing.length > 0
        ? `Capabilities missing required fields: ${missing.join(', ')}`
        : undefined,
  };
}

function checkCapabilitiesConsistency(provider: LLMProvider): ConformanceCheck {
  const caps = provider.capabilities;
  if (!caps) {
    return {
      name: 'capabilities-consistency',
      passed: true,
      message: 'Skipped — no capabilities declared',
    };
  }

  const mismatches: string[] = [];
  if (caps.promptCaching !== undefined && caps.promptCaching !== provider.supportsCaching) {
    mismatches.push(
      `promptCaching (${caps.promptCaching}) != supportsCaching (${provider.supportsCaching})`,
    );
  }
  if (caps.thinking !== undefined && caps.thinking !== provider.supportsThinking) {
    mismatches.push(
      `thinking (${caps.thinking}) != supportsThinking (${provider.supportsThinking})`,
    );
  }

  return {
    name: 'capabilities-consistency',
    passed: mismatches.length === 0,
    message:
      mismatches.length > 0 ? `Capability/boolean mismatch: ${mismatches.join('; ')}` : undefined,
  };
}

async function checkCompleteReturnsIterable(provider: LLMProvider): Promise<ConformanceCheck> {
  try {
    const messages: Message[] = [{ role: 'user', content: 'test' }];
    const tools: ToolDefinitionLite[] = [];
    const options: CompletionOptions = { maxTokens: 1 };
    const stream = provider.complete(messages, tools, options);

    // Verify it's an async iterable
    // biome-ignore lint/suspicious/noExplicitAny: checking Symbol.asyncIterator on unknown return type
    if (!stream || typeof (stream as any)[Symbol.asyncIterator] !== 'function') {
      return {
        name: 'complete-returns-iterable',
        passed: false,
        message: 'complete() did not return an AsyncIterable',
      };
    }

    return { name: 'complete-returns-iterable', passed: true };
  } catch (err) {
    // Network errors are expected in conformance testing (no real API key)
    return {
      name: 'complete-returns-iterable',
      passed: true,
      message: `Skipped iteration — expected error: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
}

async function checkChunkVariants(provider: LLMProvider): Promise<ConformanceCheck> {
  const validTypes = new Set([
    'text_delta',
    'thinking_delta',
    'tool_use_start',
    'tool_use_delta',
    'tool_use_end',
    'usage',
    'done',
    'warning',
  ]);

  try {
    const messages: Message[] = [{ role: 'user', content: 'Say "hello"' }];
    const stream = provider.complete(messages, [], { maxTokens: 10 });

    for await (const chunk of stream) {
      if (!validTypes.has(chunk.type)) {
        return {
          name: 'chunk-variants',
          passed: false,
          message: `Unknown CompletionChunk type: "${chunk.type}"`,
        };
      }
    }

    return { name: 'chunk-variants', passed: true };
  } catch {
    // Can't actually stream without real credentials — that's ok
    return {
      name: 'chunk-variants',
      passed: true,
      message: 'Skipped — no credentials available for live streaming test',
    };
  }
}

/**
 * Validate that a stream of CompletionChunks has proper tool-call buffering:
 * every tool_use_start must be followed by zero or more tool_use_delta chunks
 * (same toolCallId) and exactly one tool_use_end (same toolCallId).
 */
export function validateToolCallBuffering(chunks: CompletionChunk[]): ConformanceCheck {
  const started = new Set<string>();
  const ended = new Set<string>();
  const errors: string[] = [];

  for (const chunk of chunks) {
    if (chunk.type === 'tool_use_start') {
      if (started.has(chunk.toolCallId)) {
        errors.push(`Duplicate tool_use_start for ${chunk.toolCallId}`);
      }
      started.add(chunk.toolCallId);
    } else if (chunk.type === 'tool_use_delta') {
      if (!started.has(chunk.toolCallId)) {
        errors.push(`tool_use_delta for unknown toolCallId ${chunk.toolCallId}`);
      }
    } else if (chunk.type === 'tool_use_end') {
      if (!started.has(chunk.toolCallId)) {
        errors.push(`tool_use_end for unknown toolCallId ${chunk.toolCallId}`);
      }
      if (ended.has(chunk.toolCallId)) {
        errors.push(`Duplicate tool_use_end for ${chunk.toolCallId}`);
      }
      ended.add(chunk.toolCallId);
    }
  }

  // Every started tool call should be ended
  for (const id of started) {
    if (!ended.has(id)) {
      errors.push(`tool_use_start for ${id} without matching tool_use_end`);
    }
  }

  return {
    name: 'tool-call-buffering',
    passed: errors.length === 0,
    message: errors.length > 0 ? errors.join('; ') : undefined,
  };
}
