// vision_analyze — one-shot vision/PDF Q&A over an image or document.
//
// Flow:
//   1. resolveFile(...) normalizes one of {file_path, file_url, file_base64}
//      into { mediaType, buffer } (see ./input-resolver). All security gates
//      (path allowlist, SSRF, magic-byte detection, size caps) run there.
//   2. Pick a model: args.model > auxiliaryVisionModel > defaultModel.
//   3. Consult the capability table (./pricing). Image on a non-vision model
//      → VISION_NOT_SUPPORTED. PDF on a non-PDF model → PDF_NOT_SUPPORTED.
//   4. Resolve the LLMProvider for that model via the factory's
//      resolveProvider callback. Null → VISION_NOT_SUPPORTED (no configured
//      provider can serve the resolved model — error surface kept consistent).
//   5. Build a single user `Message` with the media block + the prompt. If
//      `format.type === 'json_schema'`, append a "Reply with ONLY a JSON
//      object matching this schema: <schema>" line — both Anthropic and
//      OpenAI comply with this pattern reliably; tool_use is overkill.
//   6. Stream provider.complete(), aggregate text_delta, capture the usage
//      chunk. Map a page-limit-flavored error to PDF_TOO_MANY_PAGES; surface
//      other errors verbatim.
//   7. On json_schema: JSON.parse + a minimal required-fields check. Failure
//      → RESPONSE_NOT_JSON with raw text in the message.
//
// Cost is taken directly from `TokenUsage.estimatedCostUsd` — the adapter
// has already computed it from the provider's reported tokens × the catalog
// price. The capability table here only gates which media each model accepts.
//
// Wiring (P3): packages/wiring/src/index.ts will call createVisionTools()
// with a resolveProvider that knows how to build an auxiliary provider for
// auxiliary.vision.* (mirroring auxiliary.compression).

import type {
  CompletionChunk,
  LLMProvider,
  Message,
  MessageContent,
  Tool,
  ToolContext,
  ToolResult,
} from '@ethosagent/types';
import { resolveFile, VisionInputError, type VisionInputErrorCode } from './input-resolver';
import { supportsPdf, supportsVision } from './pricing';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface VisionAnalyzeArgs {
  file_path?: string;
  file_url?: string;
  file_base64?: string;
  prompt?: string;
  model?: string;
  format?: { type: 'json_schema'; schema: Record<string, unknown>; name?: string };
}

export interface VisionToolsOptions {
  /**
   * Resolve an LLMProvider for a given model id. Returns null if no
   * configured provider supports it. Wiring uses this to route the call to
   * either the auxiliary vision provider (when `auxiliary.vision.model` is
   * set) or the primary provider (when the personality's main model is
   * vision-capable). Tests pass a stub.
   */
  resolveProvider: (model: string) => LLMProvider | null;
  /**
   * Default model — typically the active personality's main model. Used
   * when neither args.model nor auxiliaryVisionModel is set.
   */
  defaultModel: string;
  /**
   * Optional override from `EthosConfig.auxiliary.vision.model`. Takes
   * precedence over defaultModel but yields to args.model. Set by wiring.
   */
  auxiliaryVisionModel?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Result budget — short by design. The tool returns a JSON envelope with the
// model's text, the parsed object (if any), and usage. Long outputs (full
// document transcripts) are out of scope for v1; clip with the per-call cap.
const MAX_RESULT_CHARS = 8_000;

// Maps the resolver's domain code to the framework's ToolResult.code. The
// domain code is also surfaced as the message prefix so the LLM can pattern-
// match on it without parsing the framework code.
type ToolErrorCode = Extract<ToolResult, { ok: false }>['code'];

const RESOLVER_CODE_TO_TOOL_CODE: Record<VisionInputErrorCode, ToolErrorCode> = {
  INVALID_INPUT: 'input_invalid',
  FILE_NOT_FOUND: 'input_invalid',
  URL_BLOCKED: 'input_invalid',
  FILE_TOO_LARGE: 'input_invalid',
  UNSUPPORTED_FILE_TYPE: 'input_invalid',
};

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

export function createVisionTools(opts: VisionToolsOptions): Tool[] {
  return [makeVisionAnalyze(opts)];
}

// Surfaced for callers that want the single tool without the factory list.
export function makeVisionAnalyze(opts: VisionToolsOptions): Tool {
  return {
    name: 'vision_analyze',
    description:
      'Analyze an image (PNG/JPEG/GIF/WEBP) or PDF with a vision-capable LLM. ' +
      'Provide exactly one of file_path (personality-allowlisted), file_url (HTTPS, SSRF-checked), ' +
      "or file_base64. Returns the model's text response plus token usage and cost. " +
      'Pass format.json_schema to receive a parsed JSON object alongside the text.',
    toolset: 'vision',
    maxResultChars: MAX_RESULT_CHARS,
    // Tool output is the LLM's interpretation of an image / document the user
    // supplied — owner-authored prompt + the model's reply. Not adversary
    // content the way a fetched webpage is, but the underlying image bytes
    // can carry prompt-injection text. Conservative: tag as untrusted so
    // AgentLoop wraps the result in an <untrusted> envelope.
    outputIsUntrusted: true,
    schema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description:
            "Absolute path to a local file. Must lie within the personality's fs_reach allowlist.",
        },
        file_url: {
          type: 'string',
          description:
            'HTTPS URL to fetch. Routed through the safety-network SSRF pipeline. Max 32 MB.',
        },
        file_base64: {
          type: 'string',
          description: 'Base64-encoded file bytes. Optional "data:<mime>;base64," prefix accepted.',
        },
        prompt: {
          type: 'string',
          description: 'Question or instruction to apply to the file.',
        },
        model: {
          type: 'string',
          description:
            'Optional override for the model used. Falls back to auxiliary.vision.model, ' +
            "then to the active personality's main model.",
        },
        format: {
          type: 'object',
          description:
            'When set to { type: "json_schema", schema, name? }, the tool appends a ' +
            'schema-binding instruction to the prompt and parses the response as JSON.',
          properties: {
            type: { type: 'string', enum: ['json_schema'] },
            schema: { type: 'object' },
            name: { type: 'string' },
          },
          required: ['type', 'schema'],
        },
      },
      required: ['prompt'],
    },
    async execute(args, ctx): Promise<ToolResult> {
      return await executeVision(args as VisionAnalyzeArgs, ctx, opts);
    },
  };
}

// ---------------------------------------------------------------------------
// execute()
// ---------------------------------------------------------------------------

async function executeVision(
  args: VisionAnalyzeArgs,
  ctx: ToolContext,
  opts: VisionToolsOptions,
): Promise<ToolResult> {
  // 1. Arg validation. The resolver already enforces "exactly one of the
  //    three keys", but we pre-check prompt + format here so the error
  //    attribution stays sharp.
  if (typeof args.prompt !== 'string' || args.prompt.length === 0) {
    return fail('input_invalid', 'INVALID_INPUT: prompt is required (non-empty string)');
  }
  if (args.model !== undefined && typeof args.model !== 'string') {
    return fail('input_invalid', 'INVALID_INPUT: model must be a string');
  }
  if (args.format !== undefined) {
    const f = args.format;
    if (f.type !== 'json_schema') {
      return fail('input_invalid', 'INVALID_INPUT: format.type must be "json_schema"');
    }
    if (typeof f.schema !== 'object' || f.schema === null) {
      return fail('input_invalid', 'INVALID_INPUT: format.schema must be an object');
    }
  }

  // 2. Resolve bytes + media type.
  let mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | 'application/pdf';
  let buffer: Buffer;
  try {
    const resolved = await resolveFile(
      {
        ...(args.file_path !== undefined ? { file_path: args.file_path } : {}),
        ...(args.file_url !== undefined ? { file_url: args.file_url } : {}),
        ...(args.file_base64 !== undefined ? { file_base64: args.file_base64 } : {}),
      },
      {
        ...(ctx.storage ? { storage: ctx.storage } : {}),
        workingDir: ctx.workingDir,
        ...(ctx.networkPolicy ? { networkPolicy: ctx.networkPolicy } : {}),
        abortSignal: ctx.abortSignal,
      },
    );
    mediaType = resolved.mediaType;
    buffer = resolved.buffer;
  } catch (err) {
    if (err instanceof VisionInputError) {
      const code = RESOLVER_CODE_TO_TOOL_CODE[err.code];
      return fail(code, `${err.code}: ${err.message}`);
    }
    throw err;
  }

  // 3. Pick the model: args > aux > default.
  const model = args.model ?? opts.auxiliaryVisionModel ?? opts.defaultModel;

  // 4. Capability gate.
  const isPdf = mediaType === 'application/pdf';
  if (!isPdf && !supportsVision(model)) {
    return fail(
      'not_available',
      `VISION_NOT_SUPPORTED: model '${model}' is not vision-capable. ` +
        'Pair this personality with a vision-capable model or set auxiliary.vision.model in ~/.ethos/config.yaml.',
    );
  }
  if (isPdf && !supportsPdf(model)) {
    return fail(
      'not_available',
      `PDF_NOT_SUPPORTED: model '${model}' cannot process PDF input. ` +
        'Pair this personality with a PDF-capable model or set auxiliary.vision.model in ~/.ethos/config.yaml.',
    );
  }

  // 5. Resolve provider.
  const provider = opts.resolveProvider(model);
  if (!provider) {
    return fail(
      'not_available',
      `VISION_NOT_SUPPORTED: no LLMProvider configured for model '${model}'. ` +
        'Set auxiliary.vision.* in ~/.ethos/config.yaml so vision_analyze has a provider to route through.',
    );
  }

  // 6. Build the request.
  const userMsg = buildUserMessage({
    mediaType,
    buffer,
    prompt: args.prompt,
    schema: args.format?.schema,
  });

  // 7. Call provider.complete() and stream.
  let text = '';
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;
  try {
    const stream = provider.complete([userMsg], [], {
      modelOverride: model,
      abortSignal: ctx.abortSignal,
    });
    for await (const chunk of stream as AsyncIterable<CompletionChunk>) {
      if (chunk.type === 'text_delta') {
        text += chunk.text;
      } else if (chunk.type === 'usage') {
        inputTokens = chunk.usage.inputTokens;
        outputTokens = chunk.usage.outputTokens;
        costUsd = chunk.usage.estimatedCostUsd;
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (isPdf && looksLikePageLimit(msg)) {
      return fail('execution_failed', `PDF_TOO_MANY_PAGES: ${msg}`);
    }
    return fail('execution_failed', `LLM_ERROR: ${msg}`);
  }

  // 8. json_schema validation (if requested).
  let parsed: unknown;
  if (args.format?.type === 'json_schema') {
    const parseResult = tryParseJsonAgainstSchema(text, args.format.schema);
    if (!parseResult.ok) {
      return fail(
        'execution_failed',
        `RESPONSE_NOT_JSON: ${parseResult.reason}. Raw text: ${text}`,
      );
    }
    parsed = parseResult.value;
  }

  // 9. Envelope.
  const envelope = {
    text,
    ...(parsed !== undefined ? { parsed } : {}),
    model,
    cost_usd: costUsd,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
  };
  return { ok: true, value: JSON.stringify(envelope), cost_usd: costUsd };
}

// ---------------------------------------------------------------------------
// Message construction
// ---------------------------------------------------------------------------

function buildUserMessage(args: {
  mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | 'application/pdf';
  buffer: Buffer;
  prompt: string;
  schema?: Record<string, unknown>;
}): Message {
  const data = args.buffer.toString('base64');
  const mediaBlock: MessageContent =
    args.mediaType === 'application/pdf'
      ? { type: 'document', mediaType: 'application/pdf', data }
      : { type: 'image', mediaType: args.mediaType, data };

  const promptText = args.schema
    ? `${args.prompt}\n\nReply with ONLY a JSON object matching this schema: ${JSON.stringify(
        args.schema,
      )}`
    : args.prompt;

  return {
    role: 'user',
    content: [mediaBlock, { type: 'text', text: promptText }],
  };
}

// ---------------------------------------------------------------------------
// JSON-schema validation (intentionally tiny — see CLAUDE.md "Simplicity first")
// ---------------------------------------------------------------------------
//
// Full JSON-schema validation is out of scope for v1. We do JSON.parse +
// required-fields-on-the-top-level-object — enough to catch the common
// failure modes (non-JSON output, model dropped a required field). Anything
// past that returns RESPONSE_NOT_JSON; the caller can iterate on the prompt.
// A future revision can swap in a real validator (zod-from-json-schema,
// ajv) if real-world usage demands deeper checks.

function tryParseJsonAgainstSchema(
  text: string,
  schema: Record<string, unknown>,
): { ok: true; value: unknown } | { ok: false; reason: string } {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, reason: 'empty response' };

  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch (err) {
    return { ok: false, reason: `JSON.parse failed: ${err instanceof Error ? err.message : err}` };
  }

  // Top-level type check — only `object` is exercised by the test suite; we
  // could expand here but the v1 spec keeps it minimal.
  const expectedType = schema.type;
  if (expectedType === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return { ok: false, reason: 'expected JSON object at top level' };
    }
    const required = Array.isArray(schema.required) ? (schema.required as unknown[]) : [];
    for (const key of required) {
      if (typeof key !== 'string') continue;
      if (!(key in (value as Record<string, unknown>))) {
        return { ok: false, reason: `missing required field '${key}'` };
      }
    }
  }

  return { ok: true, value };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function looksLikePageLimit(message: string): boolean {
  const m = message.toLowerCase();
  // Anthropic surfaces "too many pages" / "page count exceeds"; OpenAI hasn't
  // standardized a wording yet, so we match a few common substrings. A
  // single false positive here mis-attributes a real error — the surfaced
  // message still contains the original text so the user can disambiguate.
  return (
    m.includes('too many pages') ||
    m.includes('page count') ||
    m.includes('page limit') ||
    m.includes('document_too_large')
  );
}

function fail(code: ToolErrorCode, error: string): Extract<ToolResult, { ok: false }> {
  return { ok: false, error, code };
}
