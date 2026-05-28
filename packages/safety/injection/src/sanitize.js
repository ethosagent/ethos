// Chat-template-token sanitization (Ch.3a foundation).
//
// Without stripping these, an attacker embeds e.g. `<|im_end|><|im_start|>system…`
// inside a webpage; once wrapped in `<untrusted>` and sent to the model, the
// embedded `<|im_start|>system` makes the model treat the rest as a real
// system instruction and the provenance fence is closed early.
//
// Each pattern is replaced with a visible placeholder so the model can see
// the content was probing rather than silently consuming the bytes.
const PLACEHOLDER = '[STRIPPED-TEMPLATE-TOKEN]';
// Order matters: longer / more specific patterns first to avoid one regex
// eating bytes another would have flagged.
const TEMPLATE_TOKEN_PATTERNS = [
    // OpenAI / ChatML / Qwen
    /<\|im_start\|>(?:system|user|assistant|tool)?/gi,
    /<\|im_end\|>/gi,
    /<\|im_sep\|>/gi,
    // Llama 2 / 3
    /<\|begin_of_text\|>/gi,
    /<\|eot_id\|>/gi,
    /<\|start_header_id\|>/gi,
    /<\|end_header_id\|>/gi,
    /<<SYS>>/gi,
    /<<\/SYS>>/gi,
    /\[INST\]/gi,
    /\[\/INST\]/gi,
    // Gemma / Gemini
    /<start_of_turn>/gi,
    /<end_of_turn>/gi,
    /<bos>/gi,
    /<eos>/gi,
    // Llama / Mistral / Mixtral sentence boundaries
    /<\/s>/gi,
    /<s>/gi,
    // Anthropic / Claude turn markers — leading-newline form is the dangerous one
    /\r?\n\r?\n(?:Human|Assistant):/g,
];
/**
 * Strip every known LLM chat-template token from `content`, replacing each
 * occurrence with a single visible placeholder. Idempotent — running it twice
 * yields the same string the second time because the placeholder itself does
 * not match any pattern.
 */
export function sanitizeTemplateTokens(content) {
    let strippedCount = 0;
    let out = content;
    for (const pattern of TEMPLATE_TOKEN_PATTERNS) {
        out = out.replace(pattern, () => {
            strippedCount++;
            return PLACEHOLDER;
        });
    }
    return { content: out, strippedCount };
}
export const STRIPPED_PLACEHOLDER = PLACEHOLDER;
