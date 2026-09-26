// xAI Responses API answer to one engine_ask question, with `web_search`.
//
// SYNTHESISED from the documented shape 2026-09-18 — NOT a live capture.
// Built from plan/phases/engine-ask-grok-gemini-microsoft.md §4.1 (output
// items `web_search_call` with `action.search.sources[].url` /
// `action.open_page.url`, a `message` whose `output_text.annotations[]` are
// `url_citation`s with the citation NUMBER in `title`, and
// `usage.server_side_tool_usage_details.web_search_calls`). Replace with a
// sanitised live capture (plan §11 M4).
export const GROK_RECORDED = {
  id: 'resp_grok_0001',
  object: 'response',
  status: 'completed',
  model: 'grok-4.6',
  output: [
    {
      type: 'web_search_call',
      id: 'ws_1',
      status: 'completed',
      action: {
        type: 'search',
        query: 'best travel credit cards india 2026',
        sources: [
          { type: 'url', url: 'https://www.cardexpert.in/best-travel-credit-cards/' },
          { type: 'url', url: 'https://www.paisabazaar.com/credit-cards/travel/' },
        ],
      },
    },
    {
      type: 'web_search_call',
      id: 'ws_2',
      status: 'completed',
      action: { type: 'open_page', url: 'https://www.axisbank.com/atlas' },
    },
    {
      type: 'message',
      id: 'msg_1',
      role: 'assistant',
      status: 'completed',
      content: [
        {
          type: 'output_text',
          text: 'Axis Atlas is the most-recommended travel card [[1]](https://www.cardexpert.in/best-travel-credit-cards/), with HDFC Infinia close behind [[2]](https://www.paisabazaar.com/credit-cards/travel/).',
          annotations: [
            {
              type: 'url_citation',
              url: 'https://www.cardexpert.in/best-travel-credit-cards/',
              start_index: 51,
              end_index: 105,
              title: '1',
            },
            {
              type: 'url_citation',
              url: 'https://www.paisabazaar.com/credit-cards/travel/',
              start_index: 137,
              end_index: 189,
              title: '2',
            },
          ],
          logprobs: [],
        },
      ],
    },
  ],
  usage: {
    input_tokens: 2150,
    output_tokens: 312,
    total_tokens: 2462,
    server_side_tool_usage_details: { web_search_calls: 2 },
  },
};
