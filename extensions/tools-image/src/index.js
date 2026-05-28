import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { BoundaryError, } from '@ethosagent/types';
import { pickProvider } from './auto-pick';
import { OpenAIDalleProvider } from './providers/openai-dalle';
import { ReplicateFluxProvider } from './providers/replicate-flux';
const dataDir = join(homedir(), '.ethos');
const VALID_SIZES = ['512x512', '1024x1024', '1024x1792', '1792x1024'];
const VALID_QUALITIES = ['standard', 'hd'];
const VALID_PROVIDERS = ['openai-dalle', 'replicate-flux', 'auto'];
function parseSize(size) {
    const [w, h] = size.split('x').map(Number);
    return { width: w ?? 1024, height: h ?? 1024 };
}
function buildDefaultProviders(opts) {
    const oaiKey = opts?.openaiApiKey;
    const repKey = opts?.replicateApiToken;
    return [
        new OpenAIDalleProvider(oaiKey ? { apiKey: oaiKey } : undefined),
        new ReplicateFluxProvider(repKey ? { apiKey: repKey } : undefined),
    ];
}
function storageOf(ctx) {
    return ctx.storage ?? null;
}
function buildImageGenerateTool(providers) {
    return {
        name: 'image_generate',
        description: 'Generate an image from a text prompt using DALL-E 3 or Replicate Flux. Returns the file path, dimensions, cost, and provider used. Requires OPENAI_API_KEY or REPLICATE_API_TOKEN.',
        toolset: 'image',
        maxResultChars: 1_000,
        capabilities: {
            network: { allowedHosts: ['api.openai.com', 'api.replicate.com', '*.replicate.delivery'] },
            secrets: ['providers/openai/apiKey', 'providers/replicate/apiToken'],
        },
        isAvailable() {
            return providers.some((p) => p.isAvailable());
        },
        schema: {
            type: 'object',
            properties: {
                prompt: { type: 'string', description: 'Text description of the image to generate' },
                output_path: {
                    type: 'string',
                    description: 'File path to save the image (default: ~/.ethos/generated/<timestamp>.png)',
                },
                size: {
                    type: 'string',
                    enum: VALID_SIZES,
                    description: 'Image dimensions (default: 1024x1024)',
                },
                quality: {
                    type: 'string',
                    enum: VALID_QUALITIES,
                    description: 'Image quality (default: standard)',
                },
                provider: {
                    type: 'string',
                    enum: VALID_PROVIDERS,
                    description: 'Provider to use (default: auto — prefers DALL-E when both keys are set)',
                },
            },
            required: ['prompt'],
        },
        async execute(args, ctx) {
            const { prompt, output_path, size = '1024x1024', quality = 'standard', provider: providerName = 'auto', } = args;
            if (!prompt)
                return { ok: false, error: 'prompt is required', code: 'input_invalid' };
            if (!VALID_SIZES.includes(size)) {
                return {
                    ok: false,
                    error: `Invalid size "${size}". Must be one of: ${VALID_SIZES.join(', ')}`,
                    code: 'input_invalid',
                };
            }
            if (!VALID_QUALITIES.includes(quality)) {
                return {
                    ok: false,
                    error: `Invalid quality "${quality}". Must be one of: ${VALID_QUALITIES.join(', ')}`,
                    code: 'input_invalid',
                };
            }
            const provider = pickProvider(providerName, providers);
            if (!provider) {
                return {
                    ok: false,
                    error: 'IMAGE_GEN_NO_PROVIDER: set OPENAI_API_KEY or REPLICATE_API_TOKEN',
                    code: 'not_available',
                };
            }
            if (!provider.supports(size, quality)) {
                return {
                    ok: false,
                    error: `INVALID_SIZE_FOR_PROVIDER: provider "${provider.name}" does not support size="${size}" quality="${quality}"`,
                    code: 'input_invalid',
                };
            }
            const stamp = new Date().toISOString().replace(/[:.]/g, '-');
            const outPath = output_path ?? join(dataDir, 'generated', `${stamp}.png`);
            let buffer;
            let cost_usd;
            let prompt_used;
            try {
                const onProgress = (msg) => ctx.emit({
                    type: 'progress',
                    toolName: 'image_generate',
                    message: msg,
                    audience: 'user',
                });
                // Resolve credentials and fetch from ctx capabilities when available.
                const secrets = ctx.secretsResolver;
                const net = ctx.scopedFetch;
                let apiKey;
                if (secrets) {
                    const secretRef = provider.name === 'replicate-flux'
                        ? 'providers/replicate/apiToken'
                        : 'providers/openai/apiKey';
                    apiKey = await secrets.get(secretRef).catch(() => undefined);
                }
                const fetchImpl = net ? net.fetch.bind(net) : undefined;
                ({ buffer, cost_usd, prompt_used } = await provider.generate({
                    prompt,
                    size,
                    quality,
                    onProgress,
                    apiKey,
                    fetchImpl,
                }));
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                const lower = msg.toLowerCase();
                if (lower.includes('content policy') ||
                    lower.includes('safety') ||
                    lower.includes('rejected')) {
                    return { ok: false, error: `IMAGE_GEN_REJECTED: ${msg}`, code: 'execution_failed' };
                }
                if (lower.includes('rate limit') ||
                    lower.includes('429') ||
                    lower.includes('too many requests')) {
                    return {
                        ok: false,
                        error: `IMAGE_GEN_QUOTA_EXCEEDED: ${msg}`,
                        code: 'execution_failed',
                    };
                }
                if (lower.includes('server error') ||
                    lower.includes('500') ||
                    lower.includes('503') ||
                    lower.includes('unavailable') ||
                    lower.includes('timeout') ||
                    lower.includes('timed out')) {
                    return {
                        ok: false,
                        error: `IMAGE_GEN_PROVIDER_UNAVAILABLE: ${msg}`,
                        code: 'execution_failed',
                    };
                }
                return { ok: false, error: msg, code: 'execution_failed' };
            }
            try {
                const storage = storageOf(ctx);
                if (!storage) {
                    return {
                        ok: false,
                        error: 'Storage capability not configured for this personality.',
                        code: 'not_available',
                    };
                }
                await storage.mkdir(dirname(outPath));
                // writeAtomic accepts Uint8Array — a partial write here would leave
                // a corrupt PNG on disk, which is worse than no file at all.
                await storage.writeAtomic(outPath, buffer);
            }
            catch (err) {
                if (err instanceof BoundaryError) {
                    return {
                        ok: false,
                        error: `OUTPUT_PATH_DENIED: ${err.kind} of "${err.path}" is outside this personality's fs_reach allowlist.`,
                        code: 'execution_failed',
                    };
                }
                return {
                    ok: false,
                    error: `Failed to write image to ${outPath}: ${err instanceof Error ? err.message : String(err)}`,
                    code: 'execution_failed',
                };
            }
            const { width, height } = parseSize(size);
            return {
                ok: true,
                cost_usd,
                value: JSON.stringify({
                    path: outPath,
                    dimensions: { width, height },
                    cost_usd,
                    provider: provider.name,
                    prompt_used,
                }),
            };
        },
    };
}
export const imageGenerateTool = buildImageGenerateTool(buildDefaultProviders());
export function createImageTools(opts) {
    const providers = opts?.providers ??
        buildDefaultProviders({
            openaiApiKey: opts?.openaiApiKey,
            replicateApiToken: opts?.replicateApiToken,
        });
    return [buildImageGenerateTool(providers)];
}
