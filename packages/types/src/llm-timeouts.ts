/**
 * Per-request deadline applied to an LLM provider's HTTP client.
 *
 * Two providers share it: `OpenAICompatProvider`
 * (`extensions/llm-openai-compat/src/index.ts`) and `AnthropicProvider`
 * (`extensions/llm-anthropic/src/index.ts`). It lives here for the same reason
 * `vision-limits.ts` does — both are extensions importing `@ethosagent/types`,
 * so one home means a change moves both at once instead of letting the two
 * clients drift. The operator override is `requestTimeoutMs` in
 * `~/.ethos/config.yaml`; both providers honour it ahead of this default.
 */

/**
 * 20 minutes. Both vendored SDKs default to 10 minutes
 * (`OpenAI.DEFAULT_TIMEOUT` / `BaseAnthropic.DEFAULT_TIMEOUT`, both `600000`);
 * this doubles that so a slow reasoning turn or a cold local model load is not
 * cut off mid-request.
 *
 * Read what this bounds carefully. Both SDKs arm the timer around the `fetch`
 * call and clear it in a `finally` once the promise settles — and `fetch`
 * settles when the response HEADERS arrive, not when the body ends. So on a
 * STREAMING request this is a time-to-first-headers deadline, and the total
 * stream duration is bounded elsewhere: by `AgentLoop`'s
 * `DEFAULT_STREAMING_TIMEOUT_MS` idle watchdog
 * (`packages/core/src/agent-loop/streaming-timeout.ts`)
 * and by `AgentBridge`'s `DEFAULT_TURN_TIMEOUT_MS` per-turn cap
 * (`packages/agent-bridge/src/agent-bridge.ts`). On a NON-streaming request,
 * where a provider withholds headers until the answer is complete, it does
 * bound the whole call — but undici's own 300s `headersTimeout` default fires
 * first, so this number is not the binding constraint there either.
 *
 * Pinned by `client-timeout.test.ts` in `extensions/llm-openai-compat` and
 * `client-timeout.test.ts` in `extensions/llm-anthropic`.
 */
export const DEFAULT_LLM_REQUEST_TIMEOUT_MS = 1_200_000;
