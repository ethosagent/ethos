// Azure AI Foundry Responses API answer to one engine_ask question, with the
// Bing-grounded `web_search` tool.
//
// SYNTHESISED from the documented shape 2026-09-18 — NOT a live capture.
// Built from plan/phases/engine-ask-grok-gemini-microsoft.md §4.3 (the
// Responses shape; `url_citation`s with `url`/`start_index`/`end_index` and NO
// `title`; no tool output returned). The `usage` field paths are the
// Responses-API names and are unconfirmed for this tool (M4 item 5). Replace
// with a sanitised live capture (plan §11 M4).
export const MICROSOFT_RECORDED = {
  id: 'resp_foundry_0001',
  object: 'response',
  status: 'completed',
  model: 'gpt-5.5',
  output: [
    { type: 'web_search_call', id: 'ws_1', status: 'completed' },
    {
      type: 'message',
      id: 'msg_1',
      role: 'assistant',
      status: 'completed',
      content: [
        {
          type: 'output_text',
          text: 'Axis Atlas is widely rated the best travel card in India, followed by HDFC Infinia.',
          annotations: [
            {
              type: 'url_citation',
              url: 'https://www.cardexpert.in/best-travel-credit-cards/',
              start_index: 0,
              end_index: 58,
            },
            {
              type: 'url_citation',
              url: 'https://www.hdfcbank.com/infinia',
              start_index: 71,
              end_index: 83,
            },
          ],
        },
      ],
    },
  ],
  usage: { input_tokens: 1480, output_tokens: 44, total_tokens: 1524 },
};
