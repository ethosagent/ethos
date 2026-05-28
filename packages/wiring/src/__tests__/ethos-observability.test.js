import { describe, expect, it } from 'vitest';
import {
  ETHOS_EVENT_CATEGORIES,
  ETHOS_TRACE_KINDS,
  EthosObservability,
} from '../observability/ethos-observability';

function makeFakeWriter() {
  const traces = [];
  const spans = [];
  const events = [];
  const tracesEnded = [];
  const spansEnded = [];
  let flushed = 0;
  let nextTraceId = 0;
  let nextSpanId = 0;
  const writer = {
    startTrace(opts) {
      traces.push(opts);
      const id = `trace-${++nextTraceId}`;
      return id;
    },
    endTrace(traceId, status) {
      tracesEnded.push({ traceId, status });
    },
    startSpan(opts) {
      spans.push(opts);
      return `span-${++nextSpanId}`;
    },
    endSpan(spanId, status) {
      spansEnded.push({ spanId, status });
    },
    recordEvent(event) {
      events.push(event);
    },
    flush() {
      flushed++;
    },
  };
  return { writer, traces, spans, events, tracesEnded, spansEnded, flushed: () => flushed };
}
describe('EthosObservability', () => {
  describe('vocabulary constants', () => {
    it('ETHOS_EVENT_CATEGORIES enumerates ethos categories', () => {
      // Plan: must include every event category currently emitted in ethos.
      expect(ETHOS_EVENT_CATEGORIES).toContain('error');
      expect(ETHOS_EVENT_CATEGORIES).toContain('audit.transition');
      expect(ETHOS_EVENT_CATEGORIES).toContain('audit.approval');
      expect(ETHOS_EVENT_CATEGORIES).toContain('audit.block');
      expect(ETHOS_EVENT_CATEGORIES).toContain('audit.watcher');
      expect(ETHOS_EVENT_CATEGORIES).toContain('audit.injection_flag');
      expect(ETHOS_EVENT_CATEGORIES).toContain('audit.redacted');
      expect(ETHOS_EVENT_CATEGORIES).toContain('audit.compaction');
      expect(ETHOS_EVENT_CATEGORIES).toContain('channel.pairing');
      expect(ETHOS_EVENT_CATEGORIES).toContain('channel.allow');
      expect(ETHOS_EVENT_CATEGORIES).toContain('channel.deny');
      expect(ETHOS_EVENT_CATEGORIES).toContain('install.scan');
      expect(ETHOS_EVENT_CATEGORIES).toContain('install.event');
    });
    it('ETHOS_TRACE_KINDS enumerates ethos trace kinds', () => {
      expect(ETHOS_TRACE_KINDS).toEqual([
        'turn',
        'mesh.handshake',
        'cron.tick',
        'channel.inbound',
        'system',
        'support.bundle',
      ]);
    });
  });
  describe('boundary translation', () => {
    it('maps personalityId → subjectId on startTurnTrace', () => {
      const { writer, traces } = makeFakeWriter();
      const obs = new EthosObservability(writer);
      obs.startTurnTrace({ sessionId: 'sess', personalityId: 'engineer' });
      expect(traces).toHaveLength(1);
      expect(traces[0]).toMatchObject({
        sessionId: 'sess',
        kind: 'turn',
        subjectId: 'engineer',
      });
    });
    it('translates obsConfig.storeToolArgs → redaction.level', () => {
      const { writer, traces } = makeFakeWriter();
      const obs = new EthosObservability(writer);
      obs.startTurnTrace({
        personalityId: 'p',
        obsConfig: { storeToolArgs: 'full', redactPatterns: ['SECRET'] },
      });
      expect(traces[0]?.redaction).toEqual({ level: 'full', extraPatterns: ['SECRET'] });
    });
    it('falls back to default redaction when obsConfig is absent', () => {
      const { writer, traces } = makeFakeWriter();
      const obs = new EthosObservability(writer, { level: 'none' });
      obs.startTurnTrace({ personalityId: 'p' });
      expect(traces[0]?.redaction).toEqual({ level: 'none' });
    });
    it('default policy is { level: redacted }', () => {
      const { writer, traces } = makeFakeWriter();
      const obs = new EthosObservability(writer);
      obs.startTurnTrace({ personalityId: 'p' });
      expect(traces[0]?.redaction).toEqual({ level: 'redacted', extraPatterns: undefined });
    });
    it('forwards snapshotId to the writer (lands in traces.snapshot_id)', () => {
      const { writer, traces } = makeFakeWriter();
      const obs = new EthosObservability(writer);
      obs.startTurnTrace({ personalityId: 'p', snapshotId: 'snap-1' });
      expect(traces[0]?.snapshotId).toBe('snap-1');
      // It must NOT be hidden inside attrs — that would orphan the snapshot
      // from the perspective of retention / archive code.
      expect(traces[0]?.attrs).toBeUndefined();
    });
  });
  describe('typed event helpers produce the right payload', () => {
    it('recordSafetyTransition emits audit.transition with structured details', () => {
      const { writer, events } = makeFakeWriter();
      const obs = new EthosObservability(writer);
      obs.recordSafetyTransition({
        sessionId: 'sess',
        fromPersonalityId: 'a',
        toPersonalityId: 'b',
        fromSnapshotId: 's1',
        toSnapshotId: 's2',
        trigger: 'pairing.approve',
        traceId: 't1',
      });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        traceId: 't1',
        category: 'audit.transition',
        severity: 'info',
        details: {
          sessionId: 'sess',
          fromPersonalityId: 'a',
          toPersonalityId: 'b',
          fromSnapshotId: 's1',
          toSnapshotId: 's2',
          trigger: 'pairing.approve',
        },
      });
    });
    it('recordWatcherDecision picks severity by decision when not overridden', () => {
      const { writer, events } = makeFakeWriter();
      const obs = new EthosObservability(writer);
      obs.recordWatcherDecision({ traceId: 't1', decision: 'pause', code: 'rule-a' });
      obs.recordWatcherDecision({ traceId: 't2', decision: 'terminate', code: 'rule-b' });
      expect(events[0]).toMatchObject({ category: 'audit.watcher', severity: 'warn' });
      expect(events[1]).toMatchObject({ category: 'audit.watcher', severity: 'critical' });
    });
    it('recordSafetyBlock defaults severity to warn', () => {
      const { writer, events } = makeFakeWriter();
      const obs = new EthosObservability(writer);
      obs.recordSafetyBlock({ traceId: 't1', code: 'tool_blocked', cause: 'denied' });
      expect(events[0]).toMatchObject({
        category: 'audit.block',
        severity: 'warn',
        code: 'tool_blocked',
        cause: 'denied',
      });
    });
    it('recordError defaults severity to error', () => {
      const { writer, events } = makeFakeWriter();
      const obs = new EthosObservability(writer);
      obs.recordError({ code: 'EBOOM', cause: 'kaboom' });
      expect(events[0]).toMatchObject({
        category: 'error',
        severity: 'error',
        code: 'EBOOM',
        cause: 'kaboom',
      });
    });
    it.each([
      ['recordChannelAllow', 'channel.allow'],
      ['recordChannelDeny', 'channel.deny'],
      ['recordChannelPairing', 'channel.pairing'],
      ['recordSkillScan', 'install.scan'],
      ['recordInstallEvent', 'install.event'],
      ['recordCompaction', 'audit.compaction'],
      ['recordInjectionFlag', 'audit.injection_flag'],
      ['recordRedacted', 'audit.redacted'],
    ])('%s emits category %s', (method, category) => {
      const { writer, events } = makeFakeWriter();
      const obs = new EthosObservability(writer);
      obs[method]?.({ code: 'k' });
      expect(events[0]?.category).toBe(category);
    });
  });
  describe('escape hatch', () => {
    it('recordEthosEvent passes through to writer', () => {
      const { writer, events } = makeFakeWriter();
      const obs = new EthosObservability(writer);
      obs.recordEthosEvent({
        category: 'audit.block',
        severity: 'warn',
        code: 'manual',
      });
      expect(events[0]).toMatchObject({ category: 'audit.block' });
    });
    // Compile-time assertion: an invalid category fails typecheck.
    // (Verified by `pnpm typecheck`; runtime is just a passthrough.)
  });
  describe('passthrough', () => {
    it('endTrace, endSpan, flush delegate to writer', () => {
      const { writer, tracesEnded, spansEnded, flushed } = makeFakeWriter();
      const obs = new EthosObservability(writer);
      obs.endTrace('t1', 'ok');
      obs.endSpan('s1', 'ok');
      obs.flush();
      expect(tracesEnded).toEqual([{ traceId: 't1', status: 'ok' }]);
      expect(spansEnded).toEqual([{ spanId: 's1', status: 'ok' }]);
      expect(flushed()).toBe(1);
    });
    it('startSpan translates obsConfig at the boundary', () => {
      const { writer, spans } = makeFakeWriter();
      const obs = new EthosObservability(writer);
      obs.startSpan({
        traceId: 't1',
        kind: 'tool_call',
        name: 'bash',
        attrs: { args: 'ls' },
        obsConfig: { storeToolArgs: 'none' },
      });
      expect(spans[0]?.redaction).toEqual({ level: 'none', extraPatterns: undefined });
    });
  });
});
