import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runSlackManifest } from '../slack-manifest';
import { EXIT, type JsonCliHarness, parseOneDoc, setupJsonCli } from './json-cli-harness';

// Task 17 (context-budget-2): `ethos slack manifest --json` wraps the generated manifest as
// {ok, format, content}. The text mode (manifest straight to stdout) is unchanged.

let h: JsonCliHarness;

beforeEach(async () => {
  h = await setupJsonCli('ethos-slack-json-');
});

afterEach(async () => {
  await h.teardown();
});

describe('slack manifest --json', () => {
  it('--json success is one JSON doc', async () => {
    await runSlackManifest(['manifest', '--name', 'Probe', '--json']);
    const doc = parseOneDoc(h);
    expect(doc.ok).toBe(true);
    expect(doc.format).toBe('json');
    expect(JSON.parse(doc.content as string).display_information.name).toBe('Probe');
    expect(h.stderr()).toBe('');
  });

  it('--json --yaml success is one JSON doc', async () => {
    await runSlackManifest(['manifest', '--yaml', '--json']);
    const doc = parseOneDoc(h);
    expect(doc.format).toBe('yaml');
    expect(doc.content).toContain('display_information:');
  });

  it('--json usage error is one JSON doc', async () => {
    await expect(runSlackManifest(['bogus', '--json'])).rejects.toThrow(`${EXIT}(1)`);
    const doc = parseOneDoc(h);
    expect(doc.ok).toBe(false);
    expect(doc.error?.code).toBe('INVALID_INPUT');
  });
});
