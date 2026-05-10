// Verifies the quick-start example in the package README runs.
// If the README's snippet diverges from the public API, this test fails.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BlobStore } from '../blob-store';
import { ObservabilityService } from '../service';
import { SQLiteObservabilityStore } from '../store';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'obs-readme-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('README quick-start example', () => {
  it('runs end-to-end and produces a queryable event', () => {
    const store = new SQLiteObservabilityStore(join(tmp, 'observability.db'));
    const blobStore = new BlobStore(join(tmp, 'blobs'), new InMemoryStorage());
    const obs = new ObservabilityService(store, blobStore);

    const traceId = obs.startTrace({
      kind: 'turn',
      subjectId: 'user-42',
      redaction: { level: 'redacted' },
    });
    const spanId = obs.startSpan({
      traceId,
      kind: 'tool_call',
      name: 'read_file',
      attrs: { args: 'AKIAIOSFODNN7EXAMPLE' },
    });
    obs.endSpan(spanId, 'ok');
    obs.recordEvent({ category: 'install.event', severity: 'info', code: 'startup' });
    obs.endTrace(traceId, 'ok');

    const events = store.getEvents({ category: 'install.event', limit: 10 });
    expect(events).toHaveLength(1);
    expect(events[0]?.code).toBe('startup');

    // Floor redaction kicked in — the AWS-key-shaped string did not survive raw.
    const span = store.getSpans(traceId)[0];
    expect(JSON.stringify(span?.attrs)).not.toContain('AKIAIOSFODNN7EXAMPLE');

    store.close();
  });
});
