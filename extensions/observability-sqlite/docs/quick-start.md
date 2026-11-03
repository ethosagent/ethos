# observability-sqlite quick start

## Quick start

```typescript
import {
  BlobStore,
  ObservabilityService,
  SQLiteObservabilityStore,
} from '@ethosagent/observability-sqlite';
import { FsStorage } from '@ethosagent/storage-fs';

const store = new SQLiteObservabilityStore('/tmp/observability.db');
const blobStore = new BlobStore('/tmp/blobs', new FsStorage());
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
  attrs: { args: 'AKIAIOSFODNN7EXAMPLE' }, // floor patterns redact AWS keys
});
obs.endSpan(spanId, 'ok');
obs.recordEvent({ category: 'install.event', severity: 'info', code: 'startup' });
obs.endTrace(traceId, 'ok');

const events = store.getEvents({ category: 'install.event', limit: 10 });
console.log(events);
store.close();
```

