import type { ImageGenProvider } from './types';

// Cost table for DALL-E 3 (USD)
const COST: Record<string, Record<string, number>> = {
  '1024x1024': { standard: 0.04, hd: 0.08 },
  '1024x1792': { standard: 0.08, hd: 0.12 },
  '1792x1024': { standard: 0.08, hd: 0.12 },
  '512x512': { standard: 0.018, hd: 0 },
};

export class OpenAIDalleProvider implements ImageGenProvider {
  readonly name = 'openai-dalle';

  isAvailable(): boolean {
    return Boolean(process.env.OPENAI_API_KEY);
  }

  supports(size: string, quality: string): boolean {
    if (size === '512x512' && quality === 'hd') return false;
    return size in COST;
  }

  async generate(opts: {
    prompt: string;
    size: string;
    quality: string;
  }): Promise<{ buffer: Buffer; cost_usd: number }> {
    // biome-ignore lint/suspicious/noExplicitAny: openai is an optional dep — no static types at this call site
    const mod = await import('openai' as any);
    const OpenAI = mod.default ?? mod;
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const response = await client.images.generate({
      model: 'dall-e-3',
      prompt: opts.prompt,
      size: opts.size,
      quality: opts.quality,
      response_format: 'b64_json',
      n: 1,
    });

    const b64 = response.data[0]?.b64_json;
    if (!b64) throw new Error('DALL-E returned no image data');

    const costRow = COST[opts.size] ?? { standard: 0.04, hd: 0.08 };
    const cost_usd = costRow[opts.quality] ?? 0.04;

    return { buffer: Buffer.from(b64, 'base64'), cost_usd };
  }
}
