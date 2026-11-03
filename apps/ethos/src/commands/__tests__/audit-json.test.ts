import { join } from 'node:path';
import { ethosDir } from '@ethosagent/config';
import { SQLiteObservabilityStore } from '@ethosagent/observability-sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runAudit } from '../audit';
import { type JsonCliHarness, parseOneDoc, setupJsonCli } from './json-cli-harness';

// Task 17 (context-budget-2): `ethos audit --json` prints exactly one JSON document.
// audit has no expected-failure path (unknown flags and subcommands list everything), so the
// "usage error" case is a gap by construction; the empty-store doc stands in for the second case.

let h: JsonCliHarness;

beforeEach(async () => {
  h = await setupJsonCli('ethos-audit-json-');
});

afterEach(async () => {
  await h.teardown();
});

function seed(): void {
  const store = new SQLiteObservabilityStore(join(ethosDir(), 'observability.db'));
  store.insertEvent({
    eventId: 'e1',
    ts: Date.now(),
    category: 'audit.transition',
    severity: 'warn',
    code: 'X_CODE',
    cause: 'because',
  });
  store.close();
}

describe('audit --json', () => {
  it('--json success is one JSON doc', async () => {
    seed();
    await runAudit(['transitions', '--json']);
    const doc = parseOneDoc(h);
    expect(doc.ok).toBe(true);
    expect(doc.title).toBe('audit — transitions');
    expect(doc.events).toEqual([
      expect.objectContaining({ eventId: 'e1', category: 'audit.transition', code: 'X_CODE' }),
    ]);
  });

  it('--json with no events is one JSON doc with an empty list', async () => {
    await runAudit(['--json']);
    expect(parseOneDoc(h)).toEqual({ ok: true, title: 'audit events', events: [] });
  });
});
