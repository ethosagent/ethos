import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCommands } from '../commands';
import { EXIT, type JsonCliHarness, parseOneDoc, setupJsonCli } from './json-cli-harness';

// Task 17 (context-budget-2): `ethos commands --json` prints exactly one JSON document.
// A global file-drop command lives under ETHOS_STATE_DIR/commands. The project scope
// (./.ethos/commands of the cwd) is not controlled here, so assertions look the command up by name.

let h: JsonCliHarness;

beforeEach(async () => {
  h = await setupJsonCli('ethos-commands-json-');
  const dir = join(h.scopeDir, '..', '..', 'commands');
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'zz-json-probe.md'),
    '---\ndescription: Probe command\n---\nDo the probe thing.\n',
  );
});

afterEach(async () => {
  await h.teardown();
});

describe('commands --json', () => {
  it('--json success is one JSON doc (list, also reached by a bare --json)', async () => {
    await runCommands(['--json']);
    const doc = parseOneDoc(h);
    expect(doc.ok).toBe(true);
    expect(doc.commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'zz-json-probe',
          scope: 'global',
          description: 'Probe command',
        }),
      ]),
    );
  });

  it('--json success is one JSON doc (show)', async () => {
    await runCommands(['show', 'zz-json-probe', '--json']);
    const doc = parseOneDoc(h);
    expect(doc.ok).toBe(true);
    expect(doc.command).toMatchObject({
      name: 'zz-json-probe',
      scope: 'global',
      description: 'Probe command',
      prompt: expect.stringContaining('Do the probe thing.'),
    });
  });

  it('--json usage error is one JSON doc', async () => {
    await expect(runCommands(['show', '--json'])).rejects.toThrow(`${EXIT}(1)`);
    const doc = parseOneDoc(h);
    expect(doc.ok).toBe(false);
    expect(doc.error?.code).toBe('INVALID_INPUT');
  });

  it('--json unknown command is one JSON doc', async () => {
    await expect(runCommands(['show', 'ghost', '--json'])).rejects.toThrow(`${EXIT}(1)`);
    expect(parseOneDoc(h).error?.code).toBe('NOT_FOUND');
  });

  it('--json unknown subcommand is one JSON doc', async () => {
    await expect(runCommands(['bogus', '--json'])).rejects.toThrow(`${EXIT}(1)`);
    expect(parseOneDoc(h).error?.code).toBe('INVALID_INPUT');
  });
});
