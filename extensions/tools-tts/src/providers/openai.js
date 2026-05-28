export class OpenAiTtsProvider {
    name = 'openai-tts';
    availableVoices = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'];
    apiKey;
    model;
    baseUrl;
    constructor(config) {
        this.apiKey = config.apiKey;
        this.model = config.model ?? 'tts-1';
        this.baseUrl = config.baseUrl ?? 'https://api.openai.com/v1';
    }
    async synthesize(text, opts) {
        const voice = opts?.voice ?? 'alloy';
        const speed = opts?.speed ?? 1.0;
        const res = await fetch(`${this.baseUrl}/audio/speech`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${this.apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model: this.model,
                input: text,
                voice,
                speed,
                response_format: 'opus',
            }),
        });
        if (!res.ok) {
            const body = await res.text().catch(() => '');
            throw new Error(`OpenAI TTS failed (${res.status}): ${body}`);
        }
        const buffer = Buffer.from(await res.arrayBuffer());
        return { audio: buffer, format: 'opus' };
    }
}
