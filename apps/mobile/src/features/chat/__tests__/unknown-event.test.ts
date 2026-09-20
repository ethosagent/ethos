import { afterEach, describe, expect, it, vi } from 'vitest';
import { opener } from '../../../api/client';
import { useChatStore } from '../../../state/chat-store';

// An app older than its server receives a frame whose `type` its bundled
// SseEventSchema does not know. The SDK routes it to `onError` without
// advancing `lastSeq`; the app must render nothing for it, surface no error
// row, and keep applying later frames on the same stream.
function sse(frames: string): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(frames));
        controller.close();
      },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('unknown event type (case 21)', () => {
  it('is dropped silently and the stream keeps applying frames', async () => {
    useChatStore.getState().reset('s1');
    const fetchMock = vi.fn(async () =>
      sse(
        'id: 1\ndata: {"type":"brand_new_event","payload":1}\n\n' +
          'id: 2\ndata: {"type":"text_delta","text":"hello"}\n\n',
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const onEvent = vi.fn((event) => useChatStore.getState().receive(event));
    const open = opener('http://10.0.0.2:3000', 'sk-ethos-test', { onEvent });
    const sub = open('/sse/sessions/s1', undefined);
    try {
      await vi.waitFor(() => expect(onEvent).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(useChatStore.getState().chat.currentTurn).not.toBeNull());
      const { chat, notices } = useChatStore.getState();
      expect(onEvent.mock.calls[0]?.[0]).toEqual({ type: 'text_delta', text: 'hello' });
      expect(chat.currentTurn?.blocks).toEqual([{ kind: 'text', content: 'hello' }]);
      expect(chat.error).toBeNull();
      expect(notices).toEqual([]);
      expect(sub.closed).toBe(false);
      expect(sub.lastSeq).toBe(2);
    } finally {
      sub.close();
    }
  });
});
