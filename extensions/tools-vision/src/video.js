// video_analyze — one-shot video Q&A with a vision-capable LLM.
//
// Claude and GPT-4o can analyze videos when given a URL in the text prompt
// (they fetch it themselves). Local file_path is not supported because the
// type system has no video content block for base64 inlining.
import { validateUrl } from '@ethosagent/safety-network';
import { supportsVideoUrl } from './pricing';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const MAX_RESULT_CHARS = 30_000;
// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------
export function createVideoAnalyzeTool(opts) {
  return {
    name: 'video_analyze',
    description:
      'Analyze a video via URL. Ask questions about video content, extract information, ' +
      'or get descriptions of what happens. Requires file_url (HTTPS link to the video).',
    toolset: 'vision',
    maxResultChars: MAX_RESULT_CHARS,
    capabilities: {
      network: { allowedHosts: ['*'] },
    },
    outputIsUntrusted: true,
    schema: {
      type: 'object',
      properties: {
        file_url: { type: 'string', description: 'URL of the video to analyze' },
        prompt: {
          type: 'string',
          description:
            'Question or instruction about the video (default: "Describe this video in detail.")',
        },
        model: { type: 'string', description: 'Override model (must support video)' },
      },
    },
    async execute(args, ctx) {
      const { file_url, prompt = 'Describe this video in detail.', model: modelArg } = args;
      if (!file_url) {
        return {
          ok: false,
          error: 'file_url is required for video analysis',
          code: 'input_invalid',
        };
      }
      // SSRF validation — only allow HTTPS URLs and block private/metadata IPs.
      if (!file_url.startsWith('https://')) {
        return { ok: false, error: 'Only HTTPS video URLs are supported', code: 'input_invalid' };
      }
      const urlCheck = await validateUrl(file_url, ctx.networkPolicy ?? {});
      if (!urlCheck.ok) {
        return { ok: false, error: `URL blocked: ${urlCheck.reason}`, code: 'input_invalid' };
      }
      const resolvedModel = modelArg ?? opts.auxiliaryVisionModel ?? opts.defaultModel;
      // Capability gate.
      if (!supportsVideoUrl(resolvedModel)) {
        return {
          ok: false,
          error:
            `VIDEO_NOT_SUPPORTED: model '${resolvedModel}' does not support video input. ` +
            'Use a video-capable model (claude-sonnet-4-6, claude-opus-4-6, gpt-5, gemini-2.5-pro) ' +
            'or set auxiliary.vision.model in ~/.ethos/config.yaml.',
          code: 'not_available',
        };
      }
      // Resolve provider.
      const provider = opts.resolveProvider(resolvedModel);
      if (!provider) {
        return {
          ok: false,
          error: `No provider available for model ${resolvedModel}`,
          code: 'not_available',
        };
      }
      try {
        const messages = [
          {
            role: 'user',
            content: `${prompt}\n\nVideo URL: ${file_url}`,
          },
        ];
        let result = '';
        for await (const chunk of provider.complete(messages, [], {
          modelOverride: resolvedModel,
        })) {
          if (chunk.type === 'text_delta') result += chunk.text;
        }
        return { ok: true, value: result || '(no analysis returned)' };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          code: 'execution_failed',
        };
      }
    },
  };
}
