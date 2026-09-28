// V2-SEC-3 — the macOS start token was `ps -o lstart=` run with the Ethos
// process's own locale and time zone, found on the host PATH and handed the
// full environment. After a restart under a different locale (launchd vs a
// shell) or a time-zone change, `matchesIdentity` judged the user's OWN live
// process 'different', so process_stop orphaned it instead of stopping it.
// The token now comes from `/bin/ps` under a fixed minimal env
// (`processStartToken`, ../process-identity.ts).

import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { matchesIdentity, processStartToken } from '../process-identity';

describe.skipIf(process.platform !== 'darwin')('darwin start token (V2-SEC-3)', () => {
  let child: ChildProcess;
  const saved = { TZ: process.env.TZ, LC_ALL: process.env.LC_ALL, LANG: process.env.LANG };

  beforeEach(() => {
    child = spawn('sleep', ['30'], { stdio: 'ignore' });
  });

  afterEach(() => {
    child.kill('SIGKILL');
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('is the same token under any locale and time zone of the Ethos process', () => {
    const pid = child.pid ?? 0;
    process.env.TZ = 'America/Los_Angeles';
    process.env.LC_ALL = 'C';
    const recorded = processStartToken(pid);
    expect(recorded).toMatch(
      /^darwin-utc:[A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2} \d\d:\d\d:\d\d \d{4}$/,
    );
    process.env.TZ = 'Asia/Kolkata';
    process.env.LC_ALL = 'de_DE.UTF-8';
    process.env.LANG = 'de_DE.UTF-8';
    expect(processStartToken(pid)).toBe(recorded);
    expect(matchesIdentity(pid, { pidStartToken: recorded ?? '' })).toBe('same');
  });

  it('does not find ps on the host PATH', () => {
    const pid = child.pid ?? 0;
    const path = process.env.PATH;
    process.env.PATH = '/nonexistent';
    try {
      expect(processStartToken(pid)).toMatch(/^darwin-utc:/);
    } finally {
      process.env.PATH = path;
    }
  });

  // A token recorded before this change is `darwin:<lstart under the process
  // env>`; it is still compared the way it was written, so an upgrade does not
  // orphan every process the registry already tracks.
  it('a pre-upgrade token still matches the process it was recorded for', () => {
    const pid = child.pid ?? 0;
    const legacy = `darwin:${execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
    }).trim()}`;
    expect(matchesIdentity(pid, { pidStartToken: legacy })).toBe('same');
    expect(matchesIdentity(pid, { pidStartToken: 'darwin:Mon Jan  1 00:00:00 2001' })).toBe(
      'different',
    );
  });
});
