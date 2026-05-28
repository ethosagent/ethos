export function pickProvider(preferredName, providers) {
    if (preferredName && preferredName !== 'auto') {
        return providers.find((p) => p.name === preferredName && p.isAvailable()) ?? null;
    }
    // auto: OPENAI_API_KEY first, then REPLICATE_API_TOKEN
    return providers.find((p) => p.isAvailable()) ?? null;
}
