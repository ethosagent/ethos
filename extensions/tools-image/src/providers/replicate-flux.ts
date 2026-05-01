import type { ImageGenProvider } from './types';

const REPLICATE_API_BASE = 'https://api.replicate.com/v1';
const FLUX_MODEL = 'black-forest-labs/flux-schnell';
const COST_PER_IMAGE = 0.003;
const POLL_INTERVAL_MS = 1_000;
const POLL_TIMEOUT_MS = 120_000;

function parseSize(size: string): { width: number; height: number } {
  const [w, h] = size.split('x').map(Number);
  return { width: w ?? 1024, height: h ?? 1024 };
}

export class ReplicateFluxProvider implements ImageGenProvider {
  readonly name = 'replicate-flux';

  isAvailable(): boolean {
    return Boolean(process.env.REPLICATE_API_TOKEN);
  }

  // Flux doesn't have hd/standard — supports all sizes
  supports(_size: string, _quality: string): boolean {
    return true;
  }

  async generate(opts: {
    prompt: string;
    size: string;
    quality: string;
  }): Promise<{ buffer: Buffer; cost_usd: number }> {
    const token = process.env.REPLICATE_API_TOKEN;
    if (!token) throw new Error('REPLICATE_API_TOKEN not set');

    const { width, height } = parseSize(opts.size);

    const createRes = await fetch(`${REPLICATE_API_BASE}/models/${FLUX_MODEL}/predictions`, {
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

    const deadline = Date.now() + POLL_TIMEOUT_MS;
    while (prediction.status !== 'succeeded' && prediction.status !== 'failed') {
      if (Date.now() > deadline) throw new Error('Replicate prediction timed out');

      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

      const pollRes = await fetch(
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

    const imgRes = await fetch(outputUrl);
    if (!imgRes.ok) throw new Error(`Failed to download image: ${imgRes.status}`);

    const arrayBuffer = await imgRes.arrayBuffer();
    return { buffer: Buffer.from(arrayBuffer), cost_usd: COST_PER_IMAGE };
  }
}
