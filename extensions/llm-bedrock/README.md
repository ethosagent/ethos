# @ethosagent/llm-bedrock

`LLMProvider` for Amazon Bedrock's ConverseStream API, signed with SigV4 and decoded from the binary AWS event stream without an AWS SDK dependency.

**Verified against spec on 2026-09-28 (no live Bedrock test).** The event-stream decoder (`src/eventstream.ts`) reproduces the reference codec's published test vectors byte for byte (smithy-typescript `packages/core/src/submodules/event-streams/eventstream-codec/TestVectors.fixture.ts`, all ten header value types, both CRCs, and the corrupted-frame refusals). ConverseStream event and exception shapes follow the Bedrock Runtime API reference (`API_runtime_ConverseStream`, `MessageStopEvent`, `TokenUsage`, `ContentBlockDelta`, `ReasoningContentBlockDelta`). Pinned by `src/__tests__/eventstream-spec.test.ts`.
