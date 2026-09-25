// `ethos upgrade` — baseline doctor, backup and health-gated rollback (plan
// openclaw-9.5-adoption item 4, D25/D26). Every npm and child-process call goes
// through `UpgradeDeps`; nothing here installs anything.

import { describe, expect, it } from 'vitest';
import {
  type ChildResult,
  type DoctorReport,
  evaluateUpgrade,
  parseDoctorReport,
  registryUrl,
  runUpgrade,
  type UpgradeDeps,
} from '../upgrade';

const CURRENT = '/old/lib/node_modules/@ethosagent/cli/dist/index.js';
const NPM_ROOT = '/g/lib/node_modules';
const INSTALLED = `${NPM_ROOT}/@ethosagent/cli/dist/index.js`;
const ARCHIVE = '/home/u/.ethos/backups/ethos-backup 1.tar.gz';

type Report = Record<string, unknown>;

function report(version: string, patch: Report = {}): Report {
  return {
    version: { name: '@ethosagent/cli', version },
    sdks: [
      { label: 'Anthropic provider', module: '@anthropic-ai/sdk', required: true, loadable: true },
      { label: 'Telegram', module: 'grammy', required: false, configured: false, loadable: true },
    ],
    secrets: [],
    awsSecrets: { enabled: false },
    db: { ok: true, absent: false },
    storeIntegrity: [{ database: 'sessions.db', status: 'ok' }],
    inboundSpool: { status: 'absent' },
    secretsDir: { tooOpen: false },
    gateway: { status: 'down', adapters: [], lastHeartbeatAgeSec: null },
    channels: [],
    callCapture: { configured: false, ok: true },
    exit: 0,
    ...patch,
  };
}

function mustParse(r: Report): DoctorReport {
  const parsed = parseDoctorReport(JSON.stringify(r));
  if (parsed === null) throw new Error('fixture is not a doctor report');
  return parsed;
}

function out(r: Report): ChildResult {
  return { stdout: `${JSON.stringify(r)}\n`, code: 0 };
}

interface Harness {
  deps: UpgradeDeps;
  installs: string[];
  runs: Array<{ entry: string; args: string[] }>;
  lines: string[];
  text(): string;
}

function harness(opts: {
  baseline?: ChildResult;
  backup?: ChildResult;
  /** Successive results of the INSTALLED binary's doctor: the gate, then the
   *  post-rollback check. */
  installed?: ChildResult[];
  installCodes?: number[];
  gatewayLive?: boolean;
}): Harness {
  const installs: string[] = [];
  const runs: Array<{ entry: string; args: string[] }> = [];
  const lines: string[] = [];
  const installed = [...(opts.installed ?? [out(report('1.1.0'))])];
  const installCodes = [...(opts.installCodes ?? [])];
  const deps: UpgradeDeps = {
    installMethod: 'npm',
    currentVersion: '1.0.0',
    currentEntry: CURRENT,
    fetchLatest: async () => '1.1.0',
    runEthos: async (entry, args) => {
      runs.push({ entry, args });
      if (entry === CURRENT && args[0] === 'doctor') return opts.baseline ?? out(report('1.0.0'));
      if (entry === CURRENT && args[0] === 'backup') {
        return (
          opts.backup ?? { stdout: `${JSON.stringify({ ok: true, path: ARCHIVE })}\n`, code: 0 }
        );
      }
      if (entry === INSTALLED && args[0] === 'doctor') {
        return installed.shift() ?? { stdout: '', code: 1, spawnError: 'no more results' };
      }
      throw new Error(`unexpected run ${entry} ${args.join(' ')}`);
    },
    npmInstall: async (spec) => {
      installs.push(spec);
      return installCodes.shift() ?? 0;
    },
    npmRootGlobal: async () => NPM_ROOT,
    readFile: async (path) => {
      if (path !== `${NPM_ROOT}/@ethosagent/cli/package.json`) throw new Error(`read ${path}`);
      return JSON.stringify({ name: '@ethosagent/cli', bin: { ethos: './dist/index.js' } });
    },
    gatewayLive: async () => opts.gatewayLive ?? false,
    log: (line) => lines.push(line),
    error: (line) => lines.push(line),
  };
  return { deps, installs, runs, lines, text: () => lines.join('\n') };
}

describe('ethos upgrade — the happy path', () => {
  it('baselines, backs up, installs the exact target, then gates on the installed binary', async () => {
    const h = harness({});
    expect(await runUpgrade([], h.deps)).toBe(0);
    expect(h.runs.map((r) => `${r.entry} ${r.args.join(' ')}`)).toEqual([
      `${CURRENT} doctor --json`,
      `${CURRENT} backup --json`,
      `${INSTALLED} doctor --json`,
    ]);
    expect(h.installs).toEqual(['@ethosagent/cli@1.1.0']);
    expect(h.text()).toContain(`Backup written to ${ARCHIVE}`);
    expect(h.text()).toContain('Upgraded to');
  });

  it('does nothing when already on the latest version', async () => {
    const h = harness({});
    h.deps.currentVersion = '1.1.0';
    expect(await runUpgrade([], h.deps)).toBe(0);
    expect(h.runs).toEqual([]);
    expect(h.installs).toEqual([]);
  });

  it('source mode prints git steps and never touches npm', async () => {
    const h = harness({});
    h.deps.installMethod = 'source';
    h.deps.fetchLatest = async () => {
      throw new Error('registry must not be hit');
    };
    expect(await runUpgrade([], h.deps)).toBe(0);
    expect(h.text()).toContain('git pull');
    expect(h.installs).toEqual([]);
  });
});

describe('ethos upgrade — baseline vs after', () => {
  it('a secret already missing before the upgrade is reported, not rolled back', async () => {
    const missing = { secrets: [{ key: 'ANTHROPIC_API_KEY', present: false }], exit: 1 };
    const h = harness({
      baseline: out(report('1.0.0', missing)),
      installed: [out(report('1.1.0', missing))],
    });
    expect(await runUpgrade([], h.deps)).toBe(0);
    expect(h.installs).toEqual(['@ethosagent/cli@1.1.0']);
    expect(h.text()).toContain('secret:ANTHROPIC_API_KEY: secret missing (already failing');
  });

  it('a secret that goes missing only after the upgrade is a regression', async () => {
    const h = harness({
      installed: [
        out(report('1.1.0', { secrets: [{ key: 'ANTHROPIC_API_KEY', present: false }] })),
        out(report('1.0.0')),
      ],
    });
    expect(await runUpgrade([], h.deps)).toBe(1);
    expect(h.installs).toEqual(['@ethosagent/cli@1.1.0', '@ethosagent/cli@1.0.0']);
    expect(h.text()).toContain('regression — secret:ANTHROPIC_API_KEY');
  });

  it('db.ok=false on the new binary rolls back', async () => {
    const h = harness({
      installed: [out(report('1.1.0', { db: { ok: false, error: 'boom' } })), out(report('1.0.0'))],
    });
    expect(await runUpgrade([], h.deps)).toBe(1);
    expect(h.installs).toEqual(['@ethosagent/cli@1.1.0', '@ethosagent/cli@1.0.0']);
    expect(h.text()).toContain('sessions.db failed to open: boom');
    expect(h.text()).toContain('Rolled back');
  });

  // Owner decision (plan openclaw-9.5-adoption item 4b, D25): a `binary` check
  // rolls back whatever the baseline said — a sessions.db that will not open,
  // or a store failing its integrity check, on the NEW binary is never
  // shrugged off as "already failing before the upgrade", because the upgrade
  // is the moment an operator can still go back. Enforced by `evaluateUpgrade`
  // (the `binary` branch ignores `before`).
  it('the same db.ok=false and storeIntegrity failure in the baseline AND the new binary still rolls back', async () => {
    const broken = {
      db: { ok: false, error: 'database disk image is malformed' },
      storeIntegrity: [{ database: 'sessions.db', status: 'failed', detail: 'page 7 corrupt' }],
    };
    const h = harness({
      baseline: out(report('1.0.0', broken)),
      installed: [out(report('1.1.0', broken)), out(report('1.0.0', broken))],
    });
    expect(await runUpgrade([], h.deps)).toBe(1);
    expect(h.installs).toEqual(['@ethosagent/cli@1.1.0', '@ethosagent/cli@1.0.0']);
    expect(h.text()).toContain('sessions.db failed to open: database disk image is malformed');
    expect(h.text()).toContain('integrity:sessions.db');
    // The rolled-back binary fails only what its own baseline failed.
    expect(h.text()).toContain('Rolled back');

    const verdict = evaluateUpgrade(
      mustParse(report('1.0.0', broken)),
      mustParse(report('1.1.0', broken)),
      '1.1.0',
    );
    expect(verdict.triggers).toEqual([
      'db: sessions.db failed to open: database disk image is malformed',
      'integrity:sessions.db: integrity check failed: page 7 corrupt',
    ]);
  });

  it('a failed integrity check or unloadable core SDK rolls back', () => {
    const baseline = mustParse(report('1.0.0'));
    const corrupt = parseDoctorReport(
      JSON.stringify(
        report('1.1.0', { storeIntegrity: [{ database: 'jobs.db', status: 'failed' }] }),
      ),
    );
    expect(evaluateUpgrade(baseline, corrupt, '1.1.0').triggers[0]).toContain('integrity:jobs.db');
    const noSdk = parseDoctorReport(
      JSON.stringify(
        report('1.1.0', {
          sdks: [{ module: '@anthropic-ai/sdk', required: true, loadable: false }],
        }),
      ),
    );
    expect(evaluateUpgrade(baseline, noSdk, '1.1.0').triggers[0]).toContain(
      'sdk:@anthropic-ai/sdk',
    );
  });

  it('gatewayStale, an unreachable channel and orphaned spool rows never roll back', async () => {
    const h = harness({
      installed: [
        out(
          report('1.1.0', {
            gateway: { status: 'stale' },
            channels: [{ platform: 'telegram', ok: false, reason: 'unreachable' }],
            inboundSpool: { status: 'ok', orphaned: [{ id: 'x' }] },
            exit: 1,
          }),
        ),
      ],
    });
    expect(await runUpgrade([], h.deps)).toBe(0);
    expect(h.installs).toEqual(['@ethosagent/cli@1.1.0']);
    expect(h.text()).toContain('gateway heartbeat stale');
    expect(h.text()).toContain('channel unreachable');
    expect(h.text()).toContain('1 owed message(s)');
  });

  it('a newly rejected channel token is a regression', () => {
    const baseline = mustParse(report('1.0.0'));
    const after = parseDoctorReport(
      JSON.stringify(
        report('1.1.0', { channels: [{ platform: 'slack', ok: false, reason: 'rejected' }] }),
      ),
    );
    expect(evaluateUpgrade(baseline, after, '1.1.0').triggers).toEqual([
      'regression — channel:slack: token rejected',
    ]);
  });
});

describe('ethos upgrade — binary-level failures roll back', () => {
  it('version mismatch', async () => {
    const h = harness({ installed: [out(report('1.0.9')), out(report('1.0.0'))] });
    expect(await runUpgrade([], h.deps)).toBe(1);
    expect(h.text()).toContain('reports version 1.0.9, not 1.1.0');
    expect(h.installs.at(-1)).toBe('@ethosagent/cli@1.0.0');
  });

  it('spawn failure', async () => {
    const h = harness({
      installed: [{ stdout: '', code: null, spawnError: 'spawn ENOENT' }, out(report('1.0.0'))],
    });
    expect(await runUpgrade([], h.deps)).toBe(1);
    expect(h.text()).toContain('the new doctor failed: spawn ENOENT');
    expect(h.installs.at(-1)).toBe('@ethosagent/cli@1.0.0');
  });

  it('non-JSON output', async () => {
    const h = harness({
      installed: [{ stdout: 'Error: Cannot find module x\n', code: 1 }, out(report('1.0.0'))],
    });
    expect(await runUpgrade([], h.deps)).toBe(1);
    expect(h.text()).toContain('printed no JSON report');
    expect(h.installs.at(-1)).toBe('@ethosagent/cli@1.0.0');
  });

  it('an unresolvable installed binary', async () => {
    const h = harness({ installed: [out(report('1.0.0'))] });
    let reads = 0;
    const realRead = h.deps.readFile;
    h.deps.readFile = async (path) => {
      reads++;
      if (reads === 1) return '{"name":"@ethosagent/cli"}';
      return realRead(path);
    };
    expect(await runUpgrade([], h.deps)).toBe(1);
    expect(h.text()).toContain('could not locate the installed binary');
    expect(h.installs.at(-1)).toBe('@ethosagent/cli@1.0.0');
  });
});

describe('ethos upgrade — rollback outcomes', () => {
  it('a failed rollback install prints the backup and the exact ethos import command', async () => {
    const h = harness({
      installed: [out(report('1.1.0', { db: { ok: false } }))],
      installCodes: [0, 7],
    });
    expect(await runUpgrade([], h.deps)).toBe(1);
    expect(h.text()).toContain('Rollback install failed (exit code 7)');
    expect(h.text()).toContain(ARCHIVE);
    expect(h.text()).toContain(`ethos import '${ARCHIVE}'`);
    expect(h.text()).toContain('npm install -g @ethosagent/cli@1.0.0');
  });

  it('a rolled-back binary that no longer matches its baseline prints ethos import', async () => {
    const h = harness({
      installed: [
        out(report('1.1.0', { db: { ok: false } })),
        out(report('1.0.0', { db: { ok: false } })),
      ],
    });
    expect(await runUpgrade([], h.deps)).toBe(1);
    expect(h.text()).toContain('does not match its baseline');
    expect(h.text()).toContain(`ethos import '${ARCHIVE}'`);
  });

  it('never runs a restore or an import itself', async () => {
    const h = harness({
      installed: [out(report('1.1.0', { db: { ok: false } }))],
      installCodes: [0, 1],
    });
    await runUpgrade([], h.deps);
    expect(h.runs.some((r) => r.args[0] === 'import')).toBe(false);
  });
});

describe('ethos upgrade — --no-rollback', () => {
  it('keeps the new binary, still prints the diff and the way back', async () => {
    const h = harness({ installed: [out(report('1.1.0', { db: { ok: false, error: 'boom' } }))] });
    expect(await runUpgrade(['--no-rollback'], h.deps)).toBe(1);
    expect(h.installs).toEqual(['@ethosagent/cli@1.1.0']);
    expect(h.text()).toContain('sessions.db failed to open: boom');
    expect(h.text()).toContain('--no-rollback');
    expect(h.text()).toContain(`ethos import '${ARCHIVE}'`);
  });
});

describe('ethos upgrade — aborts before install', () => {
  it('when the backup fails', async () => {
    const h = harness({
      backup: {
        stdout: `${JSON.stringify({ ok: false, error: { code: 'backup_locked', message: 'x' } })}\n`,
        code: 1,
      },
    });
    expect(await runUpgrade([], h.deps)).toBe(1);
    expect(h.installs).toEqual([]);
    expect(h.text()).toContain('Backup failed');
    expect(h.text()).toContain('Nothing was installed');
  });

  it('when the backup cannot be spawned', async () => {
    const h = harness({ backup: { stdout: '', code: null, spawnError: 'EACCES' } });
    expect(await runUpgrade([], h.deps)).toBe(1);
    expect(h.installs).toEqual([]);
  });

  it('when no baseline can be recorded', async () => {
    const h = harness({ baseline: { stdout: 'garbage', code: 1 } });
    expect(await runUpgrade([], h.deps)).toBe(1);
    expect(h.installs).toEqual([]);
    expect(h.runs.map((r) => r.args[0])).toEqual(['doctor']);
  });

  it('when the registry is unreachable', async () => {
    const h = harness({});
    h.deps.fetchLatest = async () => {
      throw new Error('ENOTFOUND');
    };
    expect(await runUpgrade([], h.deps)).toBe(1);
    expect(h.runs).toEqual([]);
  });

  it('an npm install failure is reported with its exit code and nothing is rolled back', async () => {
    const h = harness({ installCodes: [243] });
    expect(await runUpgrade([], h.deps)).toBe(243);
    expect(h.installs).toEqual(['@ethosagent/cli@1.1.0']);
  });
});

describe('ethos upgrade — a live gateway', () => {
  it('prints the restart hint and restarts nothing', async () => {
    const h = harness({ gatewayLive: true });
    expect(await runUpgrade([], h.deps)).toBe(0);
    expect(h.text()).toContain('systemctl --user restart ethos-gateway');
    expect(h.runs.some((r) => r.args.includes('gateway'))).toBe(false);
  });

  it('prints no hint when no gateway is running', async () => {
    const h = harness({ gatewayLive: false });
    await runUpgrade([], h.deps);
    expect(h.text()).not.toContain('restart');
  });
});

describe('registryUrl', () => {
  it('honours npm_config_registry and trims the trailing slash', () => {
    expect(registryUrl({ npm_config_registry: 'http://localhost:4873/' })).toBe(
      'http://localhost:4873',
    );
  });
  it('defaults to the public registry', () => {
    expect(registryUrl({})).toBe('https://registry.npmjs.org');
  });
});
