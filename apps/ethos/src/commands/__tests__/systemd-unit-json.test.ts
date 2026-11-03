import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runSystemdUnit } from '../systemd-unit';
import { EXIT, type JsonCliHarness, parseOneDoc, setupJsonCli } from './json-cli-harness';

// Task 17 (context-budget-2): `ethos systemd-unit <name> --json` wraps the rendered unit as
// {ok, name, content}. The text mode (unit straight to stdout) is unchanged.

let h: JsonCliHarness;

beforeEach(async () => {
  h = await setupJsonCli('ethos-systemd-json-');
});

afterEach(async () => {
  await h.teardown();
});

describe('systemd-unit --json', () => {
  it('--json success is one JSON doc', async () => {
    runSystemdUnit(['ethos-gateway', '--json']);
    const doc = parseOneDoc(h);
    expect(doc.ok).toBe(true);
    expect(doc.name).toBe('ethos-gateway');
    expect(doc.content).toContain('[Service]');
    expect(doc.content).not.toContain('{{ETHOS_');
  });

  it('--json usage error is one JSON doc', async () => {
    expect(() => runSystemdUnit(['--json'])).toThrow(`${EXIT}(2)`);
    const doc = parseOneDoc(h);
    expect(doc.ok).toBe(false);
    expect(doc.error?.code).toBe('INVALID_INPUT');
  });

  it('--json unknown unit is one JSON doc', () => {
    expect(() => runSystemdUnit(['nope', '--json'])).toThrow(`${EXIT}(2)`);
    expect(parseOneDoc(h).error?.code).toBe('INVALID_INPUT');
  });
});
