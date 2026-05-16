// vision_analyze tool — end-to-end at the tool boundary. Tests cover:
//   - happy paths (image, PDF) with a stub LLMProvider
//   - model fallback chain: args.model > auxiliaryVisionModel > defaultModel
//   - capability gate: VISION_NOT_SUPPORTED / PDF_NOT_SUPPORTED
//   - format.json_schema parse success and failure paths
//   - resolveFile error propagation (FILE_TOO_LARGE prefix)
//
// Toolset gating is enforced by ToolRegistry, not by the tool — not tested
// here per the plan.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, normalize, resolve } from 'node:path';
import type {
  CompletionChunk,
  CompletionOptions,
  LLMProvider,
  Message,
  ScopedFs,
  Tool,
  ToolContext,
  ToolDefinitionLite,
} from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createVisionTools } from '../index';

// ---------------------------------------------------------------------------
// Fixtures (mirrors input-resolver.test.ts — same minimal byte sequences).
// ---------------------------------------------------------------------------

const TINY_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082',
  'hex',
);
const TINY_PDF = Buffer.from('%PDF-1.4\n%%EOF\n', 'utf8');
// 5 MB + 1 byte (image cap is 5 MB).
const OVERSIZED_PNG = Buffer.concat([
  TINY_PNG.subarray(0, 8),
  Buffer.alloc(5 * 1024 * 1024 - 7, 0),
]);

// ---------------------------------------------------------------------------
// Stub LLMProvider — records the call, yields scripted chunks.
// ---------------------------------------------------------------------------

interface StubCall {
  messages: Message[];
  tools: ToolDefinitionLite[];
  options: CompletionOptions;
}

function makeStubProvider(opts: {
  model?: string;
  chunks: CompletionChunk[];
  calls?: StubCall[];
}): LLMProvider {
  const calls = opts.calls ?? [];
  return {
    name: 'stub',
    model: opts.model ?? 'stub-model',
    maxContextTokens: 200_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(
      messages: Message[],
      tools: ToolDefinitionLite[],
      options: CompletionOptions,
    ): AsyncIterable<CompletionChunk> {
      calls.push({ messages, tools, options });
      for (const c of opts.chunks) yield c;
    },
    async countTokens() {
      return 0;
    },
  };
}

// Provider that throws synchronously on the first `await ... of stream` step.
// Used to exercise the tool's error-mapping path. Avoids the
// `async * generator without yield` lint by yielding once before throwing —
// the yield is unreachable in practice because the throw runs in the
// first generator step.
function makeThrowingProvider(errorMessage: string): LLMProvider {
  return {
    name: 'stub',
    model: 'claude-opus-4-7',
    maxContextTokens: 200_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(): AsyncIterable<CompletionChunk> {
      if (errorMessage) throw new Error(errorMessage);
      yield { type: 'done', finishReason: 'end_turn' };
    },
    async countTokens() {
      return 0;
    },
  };
}

function happyImageChunks(text: string): CompletionChunk[] {
  return [
    { type: 'text_delta', text },
    {
      type: 'usage',
      usage: {
        inputTokens: 42,
        outputTokens: 7,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        estimatedCostUsd: 0.0012,
      },
    },
    { type: 'done', finishReason: 'end_turn' },
  ];
}

// ---------------------------------------------------------------------------
// Tool context helper — ScopedFs rooted at a per-test tmp dir.
// ---------------------------------------------------------------------------

function makeScopedFs(allowedPrefixes: string[]): ScopedFs {
  const prefixes = allowedPrefixes.map((p) => (p.endsWith('/') ? p : `${p}/`));
  return {
    async read(path: string): Promise<string> {
      const canonical = normalize(resolve(path));
      const allowed = prefixes.some(
        (pfx) => canonical === pfx.slice(0, -1) || canonical.startsWith(pfx),
      );
      if (!allowed) throw new Error(`PATH_NOT_REACHABLE: read not permitted for ${path}`);
      try {
        return readFileSync(path, 'latin1');
      } catch {
        throw new Error(`File not found: ${path}`);
      }
    },
    async write(): Promise<void> {},
    async exists(path: string): Promise<boolean> {
      const canonical = normalize(resolve(path));
      const allowed = prefixes.some(
        (pfx) => canonical === pfx.slice(0, -1) || canonical.startsWith(pfx),
      );
      if (!allowed) throw new Error(`PATH_NOT_REACHABLE: read not permitted for ${path}`);
      try {
        readFileSync(path);
        return true;
      } catch {
        return false;
      }
    },
    async list(): Promise<string[]> {
      return [];
    },
    async mtime(): Promise<number | null> {
      return null;
    },
    async mkdir(): Promise<void> {},
    async listEntries(): Promise<Array<{ name: string; isDir: boolean }>> {
      return [];
    },
  };
}

function makeCtx(opts: { workingDir: string; allowed: string[] }): ToolContext {
  return {
    sessionId: 'sess',
    sessionKey: 'cli:test',
    platform: 'test',
    workingDir: opts.workingDir,
    currentTurn: 0,
    messageCount: 0,
    abortSignal: new AbortController().signal,
    emit: () => undefined,
    resultBudgetChars: 80_000,
    scopedFs: makeScopedFs(opts.allowed),
  };
}

function getVision(opts: Parameters<typeof createVisionTools>[0]): Tool {
  const tools = createVisionTools(opts);
  const tool = tools.find((t) => t.name === 'vision_analyze');
  if (!tool) throw new Error('vision_analyze tool not registered');
  return tool;
}

// ---------------------------------------------------------------------------
// Fixtures setup
// ---------------------------------------------------------------------------

let tmpDir = '';
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'vision-tool-'));
});
afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('vision_analyze — toolset registration', () => {
  it('registers under toolset "vision"', () => {
    const tool = getVision({
      resolveProvider: () => null,
      defaultModel: 'claude-opus-4-7',
    });
    expect(tool.toolset).toBe('vision');
  });

  it('sets a maxResultChars budget cap', () => {
    const tool = getVision({
      resolveProvider: () => null,
      defaultModel: 'claude-opus-4-7',
    });
    expect(tool.maxResultChars).toBe(8_000);
  });
});

describe('vision_analyze — happy path (image)', () => {
  it('returns the streamed text, model, cost, and tokens for an image', async () => {
    const path = join(tmpDir, 'one.png');
    writeFileSync(path, TINY_PNG);

    const calls: StubCall[] = [];
    const provider = makeStubProvider({
      model: 'claude-opus-4-7',
      chunks: happyImageChunks('It looks like a red square.'),
      calls,
    });
    const tool = getVision({
      resolveProvider: (m) => (m === 'claude-opus-4-7' ? provider : null),
      defaultModel: 'claude-opus-4-7',
    });

    const ctx = makeCtx({ workingDir: tmpDir, allowed: [tmpDir] });
    const result = await tool.execute({ file_path: path, prompt: 'what color?' }, ctx);

    if (!result.ok) throw new Error(`unexpected failure: ${result.code} ${result.error}`);
    const parsed = JSON.parse(result.value);
    expect(parsed.text).toBe('It looks like a red square.');
    expect(parsed.model).toBe('claude-opus-4-7');
    expect(parsed.cost_usd).toBe(0.0012);
    expect(parsed.input_tokens).toBe(42);
    expect(parsed.output_tokens).toBe(7);

    // Confirm the request shape: one user message with an image block + text.
    expect(calls).toHaveLength(1);
    const msgs = calls[0]?.messages;
    expect(msgs).toHaveLength(1);
    expect(msgs?.[0]?.role).toBe('user');
    const content = msgs?.[0]?.content;
    if (!Array.isArray(content)) throw new Error('expected content array');
    expect(content).toHaveLength(2);
    expect(content[0]).toMatchObject({ type: 'image', mediaType: 'image/png' });
    expect(content[1]).toMatchObject({ type: 'text', text: 'what color?' });
    // modelOverride threaded so the provider call routes to the right model.
    expect(calls[0]?.options.modelOverride).toBe('claude-opus-4-7');
    // abortSignal threaded so caller cancellation reaches the provider.
    expect(calls[0]?.options.abortSignal).toBe(ctx.abortSignal);
    // No tools wired — this is a one-shot prompt.
    expect(calls[0]?.tools).toEqual([]);
  });
});

describe('vision_analyze — happy path (PDF)', () => {
  it('returns text + usage for a PDF input', async () => {
    const path = join(tmpDir, 'one.pdf');
    writeFileSync(path, TINY_PDF);

    const calls: StubCall[] = [];
    const provider = makeStubProvider({
      chunks: happyImageChunks('It says hello.'),
      calls,
    });
    const tool = getVision({
      resolveProvider: () => provider,
      defaultModel: 'claude-opus-4-7',
    });

    const result = await tool.execute(
      { file_path: path, prompt: 'summarize' },
      makeCtx({ workingDir: tmpDir, allowed: [tmpDir] }),
    );

    if (!result.ok) throw new Error(`unexpected failure: ${result.code} ${result.error}`);
    const parsed = JSON.parse(result.value);
    expect(parsed.text).toBe('It says hello.');

    const content = calls[0]?.messages[0]?.content;
    if (!Array.isArray(content)) throw new Error('expected content array');
    expect(content[0]).toMatchObject({ type: 'document', mediaType: 'application/pdf' });
  });
});

describe('vision_analyze — input validation', () => {
  it('rejects missing prompt', async () => {
    const provider = makeStubProvider({ chunks: happyImageChunks('x') });
    const tool = getVision({
      resolveProvider: () => provider,
      defaultModel: 'claude-opus-4-7',
    });
    const result = await tool.execute(
      { file_path: '/tmp/x.png' },
      makeCtx({ workingDir: tmpDir, allowed: [tmpDir] }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('input_invalid');
    expect(result.error).toMatch(/prompt/i);
  });

  it('rejects when no input key is set', async () => {
    const provider = makeStubProvider({ chunks: happyImageChunks('x') });
    const tool = getVision({
      resolveProvider: () => provider,
      defaultModel: 'claude-opus-4-7',
    });
    const result = await tool.execute(
      { prompt: 'hi' },
      makeCtx({ workingDir: tmpDir, allowed: [tmpDir] }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('input_invalid');
    expect(result.error).toContain('INVALID_INPUT:');
  });
});

describe('vision_analyze — capability gate', () => {
  it('returns VISION_NOT_SUPPORTED for an image on a non-vision model', async () => {
    const path = join(tmpDir, 'one.png');
    writeFileSync(path, TINY_PNG);

    const tool = getVision({
      // unknown / local model — capability table returns false for both flags.
      resolveProvider: () => makeStubProvider({ chunks: happyImageChunks('x') }),
      defaultModel: 'llama3:8b',
    });

    const result = await tool.execute(
      { file_path: path, prompt: 'what?' },
      makeCtx({ workingDir: tmpDir, allowed: [tmpDir] }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('not_available');
    expect(result.error).toContain('VISION_NOT_SUPPORTED');
    expect(result.error).toContain('llama3:8b');
  });

  it('returns PDF_NOT_SUPPORTED for a PDF on a vision-only model', async () => {
    const path = join(tmpDir, 'one.pdf');
    writeFileSync(path, TINY_PDF);

    const tool = getVision({
      // We assume the capability table marks gpt-5/gpt-5-mini and the major
      // Anthropic/Gemini models as both vision+pdf-capable. To exercise the
      // PDF gate we use a fictitious model and add an entry that's vision but
      // not pdf. For v1 the table doesn't ship a vision-only entry, so we
      // verify the gate by routing the synthesized error path: unknown model
      // for the PDF branch — which is also `not_available`.
      resolveProvider: () => makeStubProvider({ chunks: happyImageChunks('x') }),
      defaultModel: 'llama3:8b',
    });

    const result = await tool.execute(
      { file_path: path, prompt: 'summary' },
      makeCtx({ workingDir: tmpDir, allowed: [tmpDir] }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('not_available');
    expect(result.error).toContain('PDF_NOT_SUPPORTED');
  });
});

describe('vision_analyze — model fallback chain', () => {
  it('falls back to defaultModel when args.model and auxiliaryVisionModel are unset', async () => {
    const path = join(tmpDir, 'one.png');
    writeFileSync(path, TINY_PNG);
    const calls: StubCall[] = [];
    const tool = getVision({
      resolveProvider: () => makeStubProvider({ chunks: happyImageChunks('x'), calls }),
      defaultModel: 'claude-opus-4-7',
    });
    const result = await tool.execute(
      { file_path: path, prompt: 'p' },
      makeCtx({ workingDir: tmpDir, allowed: [tmpDir] }),
    );
    if (!result.ok) throw new Error(`unexpected failure: ${result.code} ${result.error}`);
    expect(JSON.parse(result.value).model).toBe('claude-opus-4-7');
    expect(calls[0]?.options.modelOverride).toBe('claude-opus-4-7');
  });

  it('prefers auxiliaryVisionModel over defaultModel', async () => {
    const path = join(tmpDir, 'one.png');
    writeFileSync(path, TINY_PNG);
    const calls: StubCall[] = [];
    const tool = getVision({
      resolveProvider: () => makeStubProvider({ chunks: happyImageChunks('x'), calls }),
      // primary model is non-vision; the aux vision model is.
      defaultModel: 'llama3:8b',
      auxiliaryVisionModel: 'claude-sonnet-4-6',
    });
    const result = await tool.execute(
      { file_path: path, prompt: 'p' },
      makeCtx({ workingDir: tmpDir, allowed: [tmpDir] }),
    );
    if (!result.ok) throw new Error(`unexpected failure: ${result.code} ${result.error}`);
    expect(JSON.parse(result.value).model).toBe('claude-sonnet-4-6');
  });

  it('args.model overrides both auxiliaryVisionModel and defaultModel', async () => {
    const path = join(tmpDir, 'one.png');
    writeFileSync(path, TINY_PNG);
    const calls: StubCall[] = [];
    const tool = getVision({
      resolveProvider: () => makeStubProvider({ chunks: happyImageChunks('x'), calls }),
      defaultModel: 'llama3:8b',
      auxiliaryVisionModel: 'claude-sonnet-4-6',
    });
    const result = await tool.execute(
      { file_path: path, prompt: 'p', model: 'gpt-5' },
      makeCtx({ workingDir: tmpDir, allowed: [tmpDir] }),
    );
    if (!result.ok) throw new Error(`unexpected failure: ${result.code} ${result.error}`);
    expect(JSON.parse(result.value).model).toBe('gpt-5');
  });
});

describe('vision_analyze — format.json_schema', () => {
  it('parses the assistant response as JSON and surfaces it as `parsed`', async () => {
    const path = join(tmpDir, 'one.png');
    writeFileSync(path, TINY_PNG);

    const calls: StubCall[] = [];
    const provider = makeStubProvider({
      chunks: [
        { type: 'text_delta', text: '{"a":1,"b":"hi"}' },
        {
          type: 'usage',
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            estimatedCostUsd: 0.0001,
          },
        },
        { type: 'done', finishReason: 'end_turn' },
      ],
      calls,
    });
    const tool = getVision({
      resolveProvider: () => provider,
      defaultModel: 'claude-opus-4-7',
    });

    const result = await tool.execute(
      {
        file_path: path,
        prompt: 'extract',
        format: {
          type: 'json_schema',
          schema: {
            type: 'object',
            properties: { a: { type: 'number' }, b: { type: 'string' } },
            required: ['a', 'b'],
          },
        },
      },
      makeCtx({ workingDir: tmpDir, allowed: [tmpDir] }),
    );

    if (!result.ok) throw new Error(`unexpected failure: ${result.code} ${result.error}`);
    const out = JSON.parse(result.value);
    expect(out.parsed).toEqual({ a: 1, b: 'hi' });

    // The prompt should have been augmented with the schema-binding line.
    const content = calls[0]?.messages[0]?.content;
    if (!Array.isArray(content)) throw new Error('expected content array');
    const textBlock = content.find((b) => b.type === 'text');
    expect(textBlock).toBeDefined();
    if (textBlock?.type !== 'text') throw new Error('expected text block');
    expect(textBlock.text).toContain('extract');
    expect(textBlock.text).toContain('Reply with ONLY a JSON object');
  });

  it('returns RESPONSE_NOT_JSON when the assistant text is not parseable JSON', async () => {
    const path = join(tmpDir, 'one.png');
    writeFileSync(path, TINY_PNG);
    const provider = makeStubProvider({
      chunks: [
        { type: 'text_delta', text: 'not json' },
        {
          type: 'usage',
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            estimatedCostUsd: 0.0001,
          },
        },
        { type: 'done', finishReason: 'end_turn' },
      ],
    });
    const tool = getVision({
      resolveProvider: () => provider,
      defaultModel: 'claude-opus-4-7',
    });

    const result = await tool.execute(
      {
        file_path: path,
        prompt: 'extract',
        format: { type: 'json_schema', schema: { type: 'object' } },
      },
      makeCtx({ workingDir: tmpDir, allowed: [tmpDir] }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('execution_failed');
    expect(result.error).toContain('RESPONSE_NOT_JSON');
    expect(result.error).toContain('not json');
  });

  it('rejects non-object top-level schema types up front (v1 limitation)', async () => {
    const path = join(tmpDir, 'one.png');
    writeFileSync(path, TINY_PNG);
    const provider = makeStubProvider({ chunks: happyImageChunks('x') });
    const tool = getVision({
      resolveProvider: () => provider,
      defaultModel: 'claude-opus-4-7',
    });
    const result = await tool.execute(
      {
        file_path: path,
        prompt: 'extract',
        format: {
          type: 'json_schema',
          // An array-rooted schema would silently accept any parseable JSON
          // (e.g. `{"foo":1}`) without this guard — fail loud instead.
          schema: { type: 'array', items: { type: 'string' } },
        },
      },
      makeCtx({ workingDir: tmpDir, allowed: [tmpDir] }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('input_invalid');
    expect(result.error).toContain('INVALID_INPUT:');
    expect(result.error).toContain('format.schema.type must be "object"');
  });

  it('returns RESPONSE_NOT_JSON when JSON parses but a required field is missing', async () => {
    const path = join(tmpDir, 'one.png');
    writeFileSync(path, TINY_PNG);
    const provider = makeStubProvider({
      chunks: [
        { type: 'text_delta', text: '{"a":1}' },
        {
          type: 'usage',
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            estimatedCostUsd: 0,
          },
        },
        { type: 'done', finishReason: 'end_turn' },
      ],
    });
    const tool = getVision({
      resolveProvider: () => provider,
      defaultModel: 'claude-opus-4-7',
    });

    const result = await tool.execute(
      {
        file_path: path,
        prompt: 'extract',
        format: {
          type: 'json_schema',
          schema: {
            type: 'object',
            properties: { a: { type: 'number' }, b: { type: 'string' } },
            required: ['a', 'b'],
          },
        },
      },
      makeCtx({ workingDir: tmpDir, allowed: [tmpDir] }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('RESPONSE_NOT_JSON');
  });
});

describe('vision_analyze — provider error mapping', () => {
  it('maps a page-limit provider error to PDF_TOO_MANY_PAGES', async () => {
    const path = join(tmpDir, 'one.pdf');
    writeFileSync(path, TINY_PDF);

    const provider = makeThrowingProvider('document has too many pages (max 100)');
    const tool = getVision({
      resolveProvider: () => provider,
      defaultModel: 'claude-opus-4-7',
    });
    const result = await tool.execute(
      { file_path: path, prompt: 'summary' },
      makeCtx({ workingDir: tmpDir, allowed: [tmpDir] }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('execution_failed');
    expect(result.error).toContain('PDF_TOO_MANY_PAGES');
  });

  it('surfaces other provider errors verbatim with an execution_failed code', async () => {
    const path = join(tmpDir, 'one.png');
    writeFileSync(path, TINY_PNG);
    const provider = makeThrowingProvider('rate limit exceeded');
    const tool = getVision({
      resolveProvider: () => provider,
      defaultModel: 'claude-opus-4-7',
    });
    const result = await tool.execute(
      { file_path: path, prompt: 'p' },
      makeCtx({ workingDir: tmpDir, allowed: [tmpDir] }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('execution_failed');
    expect(result.error).toContain('rate limit exceeded');
  });
});

describe('vision_analyze — resolveFile error propagation', () => {
  it('propagates FILE_TOO_LARGE from the resolver with the right prefix', async () => {
    const path = join(tmpDir, 'big.png');
    writeFileSync(path, OVERSIZED_PNG);
    const provider = makeStubProvider({ chunks: happyImageChunks('x') });
    const tool = getVision({
      resolveProvider: () => provider,
      defaultModel: 'claude-opus-4-7',
    });
    const result = await tool.execute(
      { file_path: path, prompt: 'p' },
      makeCtx({ workingDir: tmpDir, allowed: [tmpDir] }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('input_invalid');
    expect(result.error).toContain('FILE_TOO_LARGE:');
  });
});

describe('vision_analyze — no configured provider for the resolved model', () => {
  it('returns VISION_NOT_SUPPORTED when resolveProvider returns null', async () => {
    const path = join(tmpDir, 'one.png');
    writeFileSync(path, TINY_PNG);
    const tool = getVision({
      // No provider configured for any model.
      resolveProvider: () => null,
      defaultModel: 'claude-opus-4-7',
    });
    const result = await tool.execute(
      { file_path: path, prompt: 'p' },
      makeCtx({ workingDir: tmpDir, allowed: [tmpDir] }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('not_available');
    expect(result.error).toContain('VISION_NOT_SUPPORTED');
  });
});
