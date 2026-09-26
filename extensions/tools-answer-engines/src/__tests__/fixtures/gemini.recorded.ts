// Gemini Interactions API answer to one engine_ask question, with
// `google_search`.
//
// SYNTHESISED from the documented shape 2026-09-18 — NOT a live capture.
// Built from plan/phases/engine-ask-grok-gemini-microsoft.md §4.2 (`steps[]`
// of `thought` | `google_search_call` (`arguments.queries[]`) |
// `google_search_result` | `model_output`, whose `text` content carries
// `url_citation` annotations with a bare-domain `title` and BYTE-measured
// `start_index`; `usage.total_input_tokens` / `total_output_tokens`). The
// answer text contains a rupee sign, so byte and UTF-16 offsets differ. Replace
// with a sanitised live capture (plan §11 M4) — and check first whether the
// citation URLs are real publisher URLs or grounding redirects (M4 item 1).
const TEXT = 'Axis Atlas costs ₹5,000 a year and leads most lists. HDFC Infinia is invite-only.';
const enc = new TextEncoder();
const byteIndexOf = (needle: string) => enc.encode(TEXT.slice(0, TEXT.indexOf(needle))).length;

export const GEMINI_RECORDED = {
  id: 'interaction_0001',
  model: 'gemini-3.8-flash',
  status: 'completed',
  steps: [
    { type: 'thought', signature: 'c2lnbmF0dXJl' },
    {
      type: 'google_search_call',
      id: 'gs_1',
      arguments: { queries: ['best travel credit card india', 'axis atlas annual fee'] },
    },
    { type: 'google_search_result', call_id: 'gs_1' },
    {
      type: 'model_output',
      content: [
        {
          type: 'text',
          text: TEXT,
          annotations: [
            {
              type: 'url_citation',
              url: 'https://www.cardexpert.in/axis-atlas-review/',
              title: 'cardexpert.in',
              start_index: 0,
              end_index: byteIndexOf(' HDFC'),
            },
            {
              type: 'url_citation',
              url: 'https://www.hdfcbank.com/infinia',
              title: 'hdfcbank.com',
              start_index: byteIndexOf('HDFC'),
              end_index: enc.encode(TEXT).length,
            },
          ],
        },
      ],
    },
  ],
  search_suggestions: '<div class="gsi-container">…</div>',
  usage: { total_input_tokens: 1830, total_output_tokens: 96, total_tokens: 1926 },
};
