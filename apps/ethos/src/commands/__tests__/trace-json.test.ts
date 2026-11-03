import { join } from 'node:path';
import { ethosDir } from '@ethosagent/config';
import { SQLiteObservabilityStore } from '@ethosagent/observability-sqlite';
import { EthosError } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runTrace } from '../trace';
import { type JsonCliHarness, parseOneDoc, setupJsonCli } from './json-cli-harness';

// Task 17 (context-budget-2): `ethos trace --json` prints exactly one JSON document.
// trace has no usage-error path; a missing trace id THROWS an EthosError that index.ts's
// top-level catch renders (cli-json-throw.test.ts), so the second case pins the throw.

let h: JsonCliHarness;

beforeEach(async () => {
  h = await setupJsonCli('ethos-trace-json-');
});

afterEach(async () => {
  await h.teardown();
});

function seed(): void {
  const store = new SQLiteObservabilityStore(join(ethosDir(), 'observability.db'));
  store.insertTrace({ traceId: 'trace-abc', kind: 'turn', startTs: Date.now(), sessionId: 's1' });
  store.close();
}

describe('trace --json', () => {
  it('--json success is one JSON doc (list)', async () => {
    seed();
    await runTrace(['--json']);
    const doc = parseOneDoc(h);
    expect(doc.ok).toBe(true);
    expect(doc.total).toBe(1);
    expect(doc.traces).toEqual([expect.objectContaining({ traceId: 'trace-abc', kind: 'turn' })]);
  });

  it('--json success is one JSON doc (single trace)', async () => {
    seed();
    await runTrace(['trace-abc', '--json']);
    const doc = parseOneDoc(h);
    expect(doc.ok).toBe(true);
    expect(doc.trace).toMatchObject({ traceId: 'trace-abc' });
    expect(doc.spans).toEqual([]);
  });

  it('--json unknown trace throws NOT_FOUND for the top-level catch and prints nothing', async () => {
    seed();
    await expect(runTrace(['ghost', '--json'])).rejects.toMatchObject({
      code: 'NOT_FOUND',
      name: EthosError.name,
    });
    expect(h.stdout()).toBe('');
  });
});
