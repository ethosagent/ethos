import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import { BlobStore } from '../blob-store';
import { ObservabilityService } from '../service';
import { SQLiteObservabilityStore } from '../store';

function makeService() {
  const store = new SQLiteObservabilityStore(join(tmpdir(), `obs-svc-${randomUUID()}.db`));
  const blobStore = new BlobStore('/blobs', new InMemoryStorage());
  const service = new ObservabilityService(store, blobStore);
  return { service, store };
}

describe('ObservabilityService safety.observability gating', () => {
  it('storeToolArgs none: args not stored in span attrs', () => {
    const { service, store } = makeService();
    const traceId = service.startTrace({ kind: 'turn', obsConfig: { storeToolArgs: 'none' } });
    const spanId = service.startSpan({
      traceId,
      kind: 'tool_call',
      name: 'bash',
      attrs: { args: 'rm -rf /' },
      obsConfig: { storeToolArgs: 'none' },
    });
    service.endSpan(spanId, 'ok');
    const spans = store.getSpans(traceId);
    expect(spans[0]?.attrs?.args).toBeUndefined();
  });

  it('storeToolArgs redacted (default): args stored with redaction', () => {
    const { service, store } = makeService();
    const awsKey = `AKIA${'A'.repeat(16)}`;
    const traceId = service.startTrace({ kind: 'turn' });
    const spanId = service.startSpan({
      traceId,
      kind: 'tool_call',
      name: 'bash',
      attrs: { args: `key=${awsKey}` },
    });
    service.endSpan(spanId, 'ok');
    const spans = store.getSpans(traceId);
    expect(spans[0]?.attrs?.args).toContain('[REDACTED');
    expect(spans[0]?.attrs?.args).not.toContain(awsKey);
  });

  it('redactPatterns: personality extra patterns applied', () => {
    const { service, store } = makeService();
    const traceId = service.startTrace({ kind: 'turn' });
    const spanId = service.startSpan({
      traceId,
      kind: 'tool_call',
      name: 'bash',
      attrs: { args: 'INTERNAL-DOC-ABCD1234' },
      obsConfig: { redactPatterns: ['INTERNAL-DOC-[A-Z0-9]{8}'] },
    });
    service.endSpan(spanId, 'ok');
    const spans = store.getSpans(traceId);
    expect(spans[0]?.attrs?.args).toContain('[REDACTED:custom]');
    expect(spans[0]?.attrs?.args).not.toContain('INTERNAL-DOC-ABCD1234');
  });

  it('storeToolArgs full: args stored without any redaction', () => {
    const { service, store } = makeService();
    const awsKey = `AKIA${'A'.repeat(16)}`;
    const traceId = service.startTrace({ kind: 'turn', obsConfig: { storeToolArgs: 'full' } });
    const spanId = service.startSpan({
      traceId,
      kind: 'tool_call',
      name: 'bash',
      attrs: { args: `key=${awsKey}` },
      obsConfig: { storeToolArgs: 'full' },
    });
    service.endSpan(spanId, 'ok');
    const spans = store.getSpans(traceId);
    expect(spans[0]?.attrs?.args).toBe(`key=${awsKey}`);
    expect(spans[0]?.attrs?.args).not.toContain('[REDACTED');
  });

  it('traceConfig flows from startTrace to all spans in that trace', () => {
    const { service, store } = makeService();
    const traceId = service.startTrace({
      kind: 'turn',
      obsConfig: { storeToolArgs: 'none' },
    });
    // Don't pass obsConfig on startSpan — should inherit from trace
    const spanId = service.startSpan({
      traceId,
      kind: 'tool_call',
      name: 'read_file',
      attrs: { args: '/etc/passwd' },
    });
    service.endSpan(spanId, 'ok');
    const spans = store.getSpans(traceId);
    expect(spans[0]?.attrs?.args).toBeUndefined();
  });
});
