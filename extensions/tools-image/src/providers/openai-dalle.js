// Cost table for DALL-E 3 (USD) — DALL-E 3 only supports 1024x1024, 1024x1792, 1792x1024
const COST = {
    '1024x1024': { standard: 0.04, hd: 0.08 },
    '1024x1792': { standard: 0.08, hd: 0.12 },
    '1792x1024': { standard: 0.08, hd: 0.12 },
};
export class OpenAIDalleProvider {
    name = 'openai-dalle';
    apiKey;
    constructor(opts) {
        this.apiKey = opts?.apiKey;
    }
    isAvailable() {
        return Boolean(this.apiKey || process.env.OPENAI_API_KEY);
    }
    supports(size, _quality) {
        return size in COST;
    }
    async generate(opts) {
        const key = opts.apiKey ?? this.apiKey;
        if (!key)
            throw new Error('OPENAI_API_KEY not provided');
        // biome-ignore lint/suspicious/noExplicitAny: openai is an optional dep — no static types at this call site
        const mod = await import('openai');
        const OpenAI = mod.default ?? mod;
        const client = new OpenAI({ apiKey: key });
        const response = await client.images.generate({
            model: 'dall-e-3',
            prompt: opts.prompt,
            size: opts.size,
            quality: opts.quality,
            response_format: 'b64_json',
            n: 1,
        });
        const datum = response.data[0];
        const b64 = datum?.b64_json;
        if (!b64)
            throw new Error('DALL-E returned no image data');
        const costRow = COST[opts.size] ?? { standard: 0.04, hd: 0.08 };
        const cost_usd = costRow[opts.quality] ?? 0.04;
        const prompt_used = datum?.revised_prompt ?? opts.prompt;
        return { buffer: Buffer.from(b64, 'base64'), cost_usd, prompt_used };
    }
}
