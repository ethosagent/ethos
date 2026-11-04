import type { ObservabilityWriter } from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import { EthosObservability } from '../observability/ethos-observability';

function fakeWriter() {
  const events: Array<Record<string, unknown>> = [];
  const spans: Array<Record<string, unknown>> = [];
  const ended: Array<{ id: string; status: string; attrs?: Record<string, unknown> }> = [];
  const writer = {
    recordEvent: vi.fn((e: Record<string, unknown>) => void events.push(e)),
    startSpan: vi.fn((s: Record<string, unknown>) => {
      spans.push(s);
      return `span-${spans.length}`;
    }),
    endSpan: vi.fn((id: string, status: string, attrs?: Record<string, unknown>) => {
      ended.push({ id, status, attrs });
    }),
  } as unknown as ObservabilityWriter;
  return { writer, events, spans, ended };
}

describe('EthosObservability plugin host helpers', () => {
  it('records a host event under its category with the payload as details', () => {
    const f = fakeWriter();
    new EthosObservability(f.writer).recordPluginHostEvent('plugin_host.crashed', {
      plugin_id: 'p',
      code: 1,
      signal: null,
      in_flight: 2,
    });
    expect(f.events[0]).toMatchObject({
      category: 'plugin_host.crashed',
      severity: 'warn',
      details: { plugin_id: 'p', in_flight: 2 },
    });
  });

  it('puts a denied ref kind in `code` and ignores unknown categories', () => {
    const f = fakeWriter();
    const obs = new EthosObservability(f.writer);
    obs.recordPluginHostEvent('plugin_host.denied', { plugin_id: 'p', kind: 'secret', ref: 'a/b' });
    obs.recordPluginHostEvent('plugin_host.nope', {});
    expect(f.events).toHaveLength(1);
    expect(f.events[0]).toMatchObject({ code: 'secret', details: { ref: 'a/b' } });
  });

  it('is fail-open when the writer throws', () => {
    const f = fakeWriter();
    (f.writer.recordEvent as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('db locked');
    });
    (f.writer.startSpan as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('db locked');
    });
    const obs = new EthosObservability(f.writer);
    expect(() => obs.recordPluginHostEvent('plugin_host.stats', {})).not.toThrow();
    const close = obs.startPluginCallSpan({ name: 'x', attrs: {} });
    expect(() => close('ok', {})).not.toThrow();
  });

  it('writes a plugin_call span with an empty traceId and closes it with the call attrs', () => {
    const f = fakeWriter();
    const close = new EthosObservability(f.writer).startPluginCallSpan({
      name: 'tool.execute:echo',
      attrs: { plugin_id: 'p', tool_call_id: 't1' },
    });
    close('ok', { req_bytes: 1, res_bytes: 2, ipc_ms: 0.5, outcome: 'ok' });
    expect(f.spans[0]).toMatchObject({
      traceId: '',
      kind: 'plugin_call',
      name: 'tool.execute:echo',
      attrs: { tool_call_id: 't1' },
    });
    expect(f.ended[0]).toMatchObject({ id: 'span-1', status: 'ok', attrs: { outcome: 'ok' } });
  });
});
