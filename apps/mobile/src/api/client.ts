import { createEthosClient, type EthosClient, EventStream } from '@ethosagent/sdk';
import { type ActivityEvent, ActivityEventSchema, type SseEvent } from '@ethosagent/web-contracts';
import { abortSignalTimeout } from '../lib/abort';
import { createStreams, type OpenStream } from './sse';

// `src/api` is the only place the SDK is constructed. The global `fetch` is
// `expo/fetch` since SDK 56 (R3), which never times out on its own, so every
// RPC carries a 15 s abort (R6b).
export const RPC_TIMEOUT_MS = 15_000;

export function makeClient(baseUrl: string, apiKey: string): EthosClient {
  return createEthosClient({
    baseUrl,
    apiKey,
    fetch: (input, init) =>
      fetch(input, { ...init, signal: init?.signal ?? abortSignalTimeout(RPC_TIMEOUT_MS) }),
  });
}

/** The app's two SSE slots (R6a) — one instance for the process. */
export const streams = createStreams();

export interface StreamHandlers {
  onEvent(event: SseEvent, seq: number): void;
  onGap?(): void;
}

/** An `OpenStream` for `streams`, over the SDK's EventStream with the phone's
 *  jittered backoff (R6c) and 35 s stall watchdog (R6b). A frame the bundled
 *  schema does not know (an app older than its server) reaches `onError` and
 *  is dropped without a row — the stream stays open (case 21). */
export function opener(baseUrl: string, apiKey: string, handlers: StreamHandlers): OpenStream {
  return (path, sinceSeq) =>
    EventStream({
      baseUrl,
      apiKey,
      path,
      sinceSeq,
      retry: 'backoff',
      onEvent: handlers.onEvent,
      onGap: handlers.onGap,
      onError: () => undefined,
    });
}

export interface ActivityStreamHandlers {
  onEvent(event: ActivityEvent, seq: number): void;
  onGap?(): void;
}

/** An `OpenStream` for the merged `/sse/activity` feed — same policy as
 *  `opener()`, but frames are the `ActivityEvent` envelope
 *  (`{ sessionId, personalityId, event }`), not a bare `SseEvent`. */
export function activityOpener(
  baseUrl: string,
  apiKey: string,
  handlers: ActivityStreamHandlers,
): OpenStream {
  return (path, sinceSeq) =>
    EventStream({
      baseUrl,
      apiKey,
      path,
      sinceSeq,
      retry: 'backoff',
      schema: ActivityEventSchema,
      onEvent: handlers.onEvent,
      onGap: handlers.onGap,
      onError: () => undefined,
    });
}
