import { SseEventSchema } from '@ethosagent/web-contracts';
export function EventStream(opts) {
    const base = opts.baseUrl.replace(/\/+$/, '');
    const url = new URL(`${base}/sse/sessions/${opts.sessionId}`);
    if (opts.sinceSeq && opts.sinceSeq > 0) {
        url.searchParams.set('lastEventId', String(opts.sinceSeq));
    }
    const ac = new AbortController();
    const state = { lastSeq: opts.sinceSeq ?? 0, closed: false };
    if (opts.signal) {
        opts.signal.addEventListener('abort', () => ac.abort(), { once: true });
    }
    void consume(url.toString(), opts, ac.signal, state);
    return {
        close() {
            state.closed = true;
            ac.abort();
        },
        get lastSeq() {
            return state.lastSeq;
        },
        get closed() {
            return state.closed;
        },
    };
}
async function consume(url, opts, signal, state) {
    const RETRY_DELAY_MS = 3000;
    while (!signal.aborted) {
        try {
            const headers = { Accept: 'text/event-stream' };
            if (opts.apiKey)
                headers.Authorization = `Bearer ${opts.apiKey}`;
            const res = await fetch(url, {
                headers,
                ...(!opts.apiKey ? { credentials: 'include' } : {}),
                signal,
            });
            if (!res.ok) {
                throw new Error(`SSE connection failed: ${res.status} ${res.statusText}`);
            }
            const body = res.body;
            if (!body)
                throw new Error('Response body is null');
            const reader = body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            let currentId = '';
            let currentData = '';
            for (;;) {
                const { done, value } = await reader.read();
                if (done)
                    break;
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() ?? '';
                for (const line of lines) {
                    if (line.startsWith('id:')) {
                        currentId = line.slice(3).trim();
                    }
                    else if (line.startsWith('data:')) {
                        currentData += line.slice(5);
                    }
                    else if (line === '') {
                        if (currentData) {
                            const seq = currentId ? Number(currentId) : state.lastSeq + 1;
                            try {
                                const json = JSON.parse(currentData);
                                const event = SseEventSchema.parse(json);
                                state.lastSeq = seq;
                                opts.onEvent(event, seq);
                            }
                            catch (err) {
                                opts.onError?.(err);
                            }
                        }
                        currentId = '';
                        currentData = '';
                    }
                }
            }
        }
        catch (err) {
            if (signal.aborted)
                break;
            opts.onError?.(err);
        }
        if (signal.aborted)
            break;
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    }
    state.closed = true;
}
