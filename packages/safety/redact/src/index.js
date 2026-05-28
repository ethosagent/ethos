const PATTERNS = [
    { label: 'GitHub PAT', tag: '[REDACTED:github-pat]', regex: /ghp_[A-Za-z0-9]{36}/g },
    { label: 'GitHub PAT', tag: '[REDACTED:github-pat]', regex: /github_pat_[A-Za-z0-9_]{82}/g },
    {
        label: 'Anthropic API key',
        tag: '[REDACTED:anthropic-key]',
        regex: /sk-ant-[A-Za-z0-9_-]{93,}/g,
    },
    {
        label: 'OpenAI API key',
        tag: '[REDACTED:openai-key]',
        regex: /sk-(?:proj-)?[A-Za-z0-9_-]{40,}/g,
    },
    { label: 'AWS access key', tag: '[REDACTED:aws-key]', regex: /AKIA[0-9A-Z]{16}/g },
    {
        label: 'Slack token',
        tag: '[REDACTED:slack-token]',
        regex: /xox[bpoa]-[0-9]{10,}-[0-9]{10,}-[A-Za-z0-9]{24,}/g,
    },
    {
        label: 'Slack app token',
        tag: '[REDACTED:slack-token]',
        regex: /xapp-[0-9]+-[A-Za-z0-9]+-[A-Za-z0-9]+/g,
    },
    { label: 'Stripe key', tag: '[REDACTED:stripe-key]', regex: /sk_live_[A-Za-z0-9]{24,}/g },
    { label: 'Groq API key', tag: '[REDACTED:groq-key]', regex: /gsk_[A-Za-z0-9]{20,}/g },
    {
        label: 'Generic secret',
        tag: '[REDACTED:generic-secret]',
        // biome-ignore format: long regex must stay on one line
        regex: /(?<=^|[\s,{;(])(?:key|token|password|secret)=["']?[A-Za-z0-9+/=_-]{20,}["']?/gi,
    },
];
export function detectSecrets(value) {
    const detections = [];
    for (const p of PATTERNS) {
        p.regex.lastIndex = 0;
        if (p.regex.test(value)) {
            detections.push({ label: p.label });
            p.regex.lastIndex = 0;
        }
    }
    return detections;
}
export function redactString(value, extraPatterns) {
    let out = value;
    for (const p of PATTERNS) {
        out = out.replace(p.regex, p.tag);
    }
    if (extraPatterns) {
        for (const pat of extraPatterns) {
            try {
                out = out.replace(new RegExp(pat, 'g'), '[REDACTED:custom]');
            }
            catch {
                // Invalid regex — skip silently
            }
        }
    }
    return out;
}
export function redactJson(obj, extraPatterns) {
    return redactValue(obj, extraPatterns);
}
function redactValue(v, extraPatterns) {
    if (typeof v === 'string')
        return redactString(v, extraPatterns);
    if (Array.isArray(v))
        return v.map((item) => redactValue(item, extraPatterns));
    if (v !== null && typeof v === 'object') {
        const out = {};
        for (const [k, val] of Object.entries(v)) {
            out[k] = redactValue(val, extraPatterns);
        }
        return out;
    }
    return v;
}
