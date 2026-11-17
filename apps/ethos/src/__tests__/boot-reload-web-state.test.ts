// `webServer` / `webRequested` are `let`s in `runBoot` (commands/boot.ts) with
// two writers-and-readers: the Phase D rebind in `startConfigReload`
// (commands/boot-reload.ts) replaces them, and shutdown's
// `closeListener(webServer)` must close whichever listener is CURRENT. The
// phase reaches them only through the `web` getter/setter box, so a copy taken
// at phase start would silently leave shutdown closing a dead listener. Like
// the other boot wiring tests, this is a source assertion: boot.ts is not
// runnable end to end under vitest.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bootFileWith } from '../commands/__tests__/boot-sources';

const COMMANDS = join(import.meta.dirname, '..', 'commands');
const read = (name: string) => readFile(join(COMMANDS, name), 'utf8');

describe('boot live-reload phase — shared web-bind state', () => {
  it('runBoot hands the phase live accessors over its own lets', async () => {
    const boot = bootFileWith(
      'let webRequested: WebBindTarget = ',
      'let webServer = firstBind.server;',
    );
    expect(boot).toMatch(/let webRequested: WebBindTarget = /);
    expect(boot).toMatch(/let webServer = firstBind\.server;/);
    expect(boot).toMatch(
      /get server\(\) \{\s*return webServer;\s*\},\s*set server\(next\) \{\s*webServer = next;\s*\}/,
    );
    expect(boot).toMatch(
      /get requested\(\) \{\s*return webRequested;\s*\},\s*set requested\(next\) \{\s*webRequested = next;\s*\}/,
    );
    expect(boot).toContain('() => closeListener(webServer),');
  });

  it('the phase reads and writes through the box, never a captured copy', async () => {
    const reload = await read('boot-reload.ts');
    const code = reload
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n');
    expect(code).not.toMatch(/\bwebServer\b|\bwebRequested\b/);
    expect(reload).not.toMatch(/const \{[^}]*\b(server|requested)\b[^}]*\} = web/);
    expect(reload).toContain('planWebRebind(web.requested, source, args, process.env)');
    expect(reload).toMatch(/server: web\.server,\s*current: web\.requested,/);
    expect(reload).toMatch(/web\.server = outcome\.server;\s*web\.requested = outcome\.requested;/);
  });
});
