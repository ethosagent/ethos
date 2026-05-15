import type { GenerateOpts, GenerateResult, ImageGenProvider } from './types';

const REPLICATE_API_BASE = 'https://api.replicate.com/v1';
const FLUX_MODEL = 'black-forest-labs/flux-schnell';
const COST_PER_IMAGE = 0.003;
const POLL_INTERVAL_MS = 1_000;
const POLL_TIMEOUT_MS = 30_000;

function parseSize(size: string): { width: number; height: number } {
  const [w, h] = size.split('x').map(Number);
  return { width: w ?? 1024, height: h ?? 1024 };
}

export class ReplicateFluxProvider implements ImageGenProvider {
  readonly name = 'replicate-flux';
  private readonly apiKey: string | undefined;

  constructor(opts?: { apiKey?: string }) {
    this.apiKey = opts?.apiKey;
  }

  isAvailable(): boolean {
    return Boolean(this.apiKey || process.env.REPLICATE_API_TOKEN);
  }

  // Flux doesn't have hd/standard — supports all sizes
  supports(_size: string, _quality: string): boolean {
    return true;
  }

  async generate(opts: GenerateOpts): Promise<GenerateResult> {
    const token = opts.apiKey ?? this.apiKey;
    if (!token) throw new Error('REPLICATE_API_TOKEN not set');

    const doFetch = opts.fetchImpl ?? fetch;
    const { width, height } = parseSize(opts.size);

    const createRes = await doFetch(`${REPLICATE_API_BASE}/models/${FLUX_MODEL}/predictions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Prefer: 'wait',
      },
      body: JSON.stringify({
        input: { prompt: opts.prompt, width, height, num_outputs: 1 },
      }),
    });

    if (!createRes.ok) {
      const body = await createRes.text().catch(() => '');
      throw new Error(`Replicate API error ${createRes.status}: ${body}`);
    }

    let prediction = (await createRes.json()) as {
      id: string;
      status: string;
      output?: string[];
      error?: string;
      urls?: { get: string };
    };

    const startTime = Date.now();
    const deadline = startTime + POLL_TIMEOUT_MS;
    while (prediction.status !== 'succeeded' && prediction.status !== 'failed') {
      if (Date.now() > deadline) throw new Error('Replicate prediction timed out');

      const elapsed = Math.round((Date.now() - startTime) / 1000);
      opts.onProgress?.(`generating (Flux polling: ${elapsed}s)`);

      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

      const pollRes = await doFetch(
        prediction.urls?.get ?? `${REPLICATE_API_BASE}/predictions/${prediction.id}`,
        {
          headers: { Authorization: `Bearer ${token}` },
        },
      );

      if (!pollRes.ok) {
        const body = await pollRes.text().catch(() => '');
        throw new Error(`Replicate poll error ${pollRes.status}: ${body}`);
      }

      prediction = await pollRes.json();
    }

    if (prediction.status === 'failed') {
      throw new Error(`Replicate prediction failed: ${prediction.error ?? 'unknown error'}`);
    }

    const outputUrl = prediction.output?.[0];
    if (!outputUrl) throw new Error('Replicate returned no output URL');

    const imgRes = await doFetch(outputUrl);
    if (!imgRes.ok) throw new Error(`Failed to download image: ${imgRes.status}`);

    const arrayBuffer = await imgRes.arrayBuffer();
    return {
      buffer: Buffer.from(arrayBuffer),
      cost_usd: COST_PER_IMAGE,
      prompt_used: opts.prompt,
    };
  }
}
