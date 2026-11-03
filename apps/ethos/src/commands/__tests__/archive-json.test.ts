import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runArchive } from '../archive';
import { EXIT, type JsonCliHarness, parseOneDoc, setupJsonCli } from './json-cli-harness';

// Task 17 (context-budget-2): `ethos archive --json` prints exactly one JSON document.
// Gap: a successful restore needs a real tar.gz archive; only list and prune are driven here.

let h: JsonCliHarness;

beforeEach(async () => {
  h = await setupJsonCli('ethos-archive-json-');
});

afterEach(async () => {
  await h.teardown();
});

describe('archive --json', () => {
  it('--json success is one JSON doc (list, also reached by a bare --json)', async () => {
    await runArchive('--json', []);
    expect(parseOneDoc(h)).toEqual({ ok: true, archives: [] });
  });

  it('--json success is one JSON doc (prune)', async () => {
    await runArchive('prune', ['--older-than', '730d', '--json']);
    expect(parseOneDoc(h)).toEqual({ ok: true, removed: 0 });
  });

  it('--json usage error is one JSON doc', async () => {
    await expect(runArchive('restore', ['nope', '--json'])).rejects.toThrow(`${EXIT}(1)`);
    const doc = parseOneDoc(h);
    expect(doc.ok).toBe(false);
    expect(doc.error?.code).toBe('INVALID_INPUT');
  });

  it('--json unknown subcommand is one JSON doc', async () => {
    await expect(runArchive('bogus', ['--json'])).rejects.toThrow(`${EXIT}(1)`);
    expect(parseOneDoc(h).error?.code).toBe('INVALID_INPUT');
  });

  it('--json is position-independent: restore --json <month> reads the month', async () => {
    // The month is parsed (no INVALID_INPUT doc, no exit); the missing archive then throws.
    await expect(runArchive('restore', ['--json', '2020-01'])).rejects.toThrow(
      expect.not.objectContaining({ message: expect.stringContaining(EXIT) }),
    );
    expect(h.stdout()).toBe('');
  });

  it('--json restore failure propagates to the top-level catch', async () => {
    await expect(runArchive('restore', ['2020-01', '--json'])).rejects.toThrow();
    expect(h.stdout()).toBe('');
  });
});
