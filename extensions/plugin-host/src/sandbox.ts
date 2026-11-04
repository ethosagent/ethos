import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { sensitiveDenyPaths } from '@ethosagent/storage-fs';

/**
 * `plugins.host.sandbox: auto` (plan §5.8, D22). An OS wrapper around the host
 * process: Seatbelt (`sandbox-exec`) on macOS, `bwrap` on Linux. It is a
 * DENY-LIST profile over an allow-default base, so it is only as good as its
 * list; it is not called a sandbox guarantee anywhere and produces no S2
 * attestation (D7). `auto` fails closed (`PLUGIN_HOST_SANDBOX_UNAVAILABLE`)
 * when no wrapper works; nothing here is ever a silent fallback.
 *
 * Limitations, pinned or recorded in `__tests__/sandbox.test.ts`:
 *  - Network is all-or-nothing (D16): `network: null` denies it; a declared
 *    host list allows everything, because Seatbelt and bwrap cannot filter by
 *    hostname.
 *  - macOS: Seatbelt is deprecated in its man page but still shipped; a profile
 *    matches REAL paths, so `/var`, `/tmp` and `/etc` are emitted in their
 *    `/private/...` form too.
 *  - Linux (bwrap) is written from the plan and the bwrap man page; no Linux
 *    box was available to run it.
 */

export type SandboxKind = 'seatbelt' | 'bwrap';

export type SandboxDetection =
  | { kind: SandboxKind; command: string }
  | { kind: 'unavailable'; reason: string };

export interface SandboxSpec {
  /** The Ethos state dir: denied wholesale except the host's own dir and the package. */
  dataDir: string;
  /** `<dataDir>/plugin-hosts/<id>`: read-write, holds the host's HOME and TMPDIR. */
  hostDir: string;
  /** The plugin's package dir, read-only. */
  pluginDir: string;
  /** The grant's `ethos.permissions.network`. `null` denies network; anything else leaves it open. */
  network: string[] | null | undefined;
  /** Replaces `os.homedir()`. Tests only. */
  homeDir?: string;
  /** Replaces `sensitiveDenyPaths()`. Tests only. */
  denyPaths?: readonly string[];
}

/** Home-relative secrets denied beyond `sensitiveDenyPaths()` (plan §5.8). */
const HOME_SECRET_DIRS = ['.ssh', '.aws', '.config/gcloud', '.gnupg', 'Library/Keychains'] as const;
const HOME_SECRET_FILES = ['.npmrc', '.netrc'] as const;

function homeOf(spec: SandboxSpec): string {
  return spec.homeDir ?? homedir();
}

/** Every path the profile denies: the shared manifest, plus the home secrets, deduplicated. */
export function deniedPaths(spec: SandboxSpec): string[] {
  const home = homeOf(spec);
  const all = [
    ...(spec.denyPaths ?? sensitiveDenyPaths()),
    ...HOME_SECRET_DIRS.map((d) => join(home, d)),
    ...HOME_SECRET_FILES.map((f) => join(home, f)),
  ];
  return [...new Set(all)];
}

/**
 * The directories the package needs read access to. A package under a
 * `node_modules` tree gets the outermost `node_modules` dir, because its
 * dependencies are hoisted beside it (`<dataDir>/plugins/node_modules/*`).
 * That also lets the host read sibling plugins' code, not their credentials.
 */
export function readOnlyDirs(pluginDir: string): string[] {
  const marker = '/node_modules/';
  const at = pluginDir.indexOf(marker);
  if (at === -1) return [pluginDir];
  return [pluginDir.slice(0, at + marker.length - 1), pluginDir];
}

/** macOS resolves `/var`, `/tmp` and `/etc` through symlinks, and Seatbelt matches the real path. */
function seatbeltForms(path: string): string[] {
  const forms = [path];
  if (/^\/(?:var|tmp|etc)(?:\/|$)/.test(path)) forms.push(`/private${path}`);
  return forms;
}

/**
 * One Seatbelt string literal. Backslash and double quote are escaped, and a
 * control character is refused, so a path or plugin id cannot end the literal
 * and add rules (pinned by `sandbox.test.ts` "profile escaping").
 */
export function sbplString(value: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point
  if (/[\x00-\x1f\x7f]/.test(value)) {
    throw new Error('A sandbox path may not contain control characters');
  }
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

const subpaths = (paths: readonly string[]): string =>
  paths
    .flatMap(seatbeltForms)
    .map((p) => `(subpath ${sbplString(p)})`)
    .join(' ');

/**
 * The Seatbelt profile. Seatbelt is last-match-wins, so the order is the
 * policy:
 *   1. allow everything;
 *   2. deny read and write on the whole state dir, then on every sensitive path;
 *   3. allow the host's own dir read-write, the package (and hoisted
 *      `node_modules`) read-only, and deny writes to the package again;
 *   4. `(deny network*)` when the grant declares no network.
 * The denies use `file-read-data`, not `file-read*` (a deviation from plan §5.8):
 * `file-read*` also denies `lstat`, and Node's module resolution and
 * `realpath` lstat every ancestor of the plugin's package, which then
 * fails with EPERM. With `file-read-data`, opening or listing anything under the
 * state dir fails, but a path's existence and size are still visible. Pinned by
 * `sandbox.test.ts` ("a package under the denied state dir still loads").
 */
export function seatbeltProfile(spec: SandboxSpec): string {
  const lines = [
    '(version 1)',
    '(allow default)',
    `(deny file-read-data file-write* ${subpaths([spec.dataDir])})`,
    `(deny file-read-data file-write* ${subpaths(deniedPaths(spec))})`,
    `(allow file-read-data file-write* ${subpaths([spec.hostDir])})`,
    `(allow file-read-data ${subpaths(readOnlyDirs(spec.pluginDir))})`,
    `(deny file-write* ${subpaths([spec.pluginDir])})`,
  ];
  if (spec.network === null) lines.push('(deny network*)');
  return lines.join('\n');
}

/** Existing-path candidates the Linux profile masks; the pool checks which exist (bwrap cannot mount over a missing path on a read-only root). */
export function bwrapMaskCandidates(spec: SandboxSpec): { dirs: string[]; files: string[] } {
  const home = homeOf(spec);
  return {
    dirs: HOME_SECRET_DIRS.map((d) => join(home, d)),
    files: HOME_SECRET_FILES.map((f) => join(home, f)),
  };
}

/**
 * The bwrap argv. Root is read-only, `<dataDir>` is replaced by an empty
 * tmpfs, then the host dir (rw) and the package (ro) are bound back over it.
 * Home secrets that exist are masked: directories with tmpfs, files with
 * `/dev/null`. The parent's `HOME` is NOT otherwise hidden.
 */
export function bwrapArgs(spec: SandboxSpec, existing: ReadonlySet<string>): string[] {
  const { dirs, files } = bwrapMaskCandidates(spec);
  const args = [
    '--ro-bind',
    '/',
    '/',
    '--dev',
    '/dev',
    '--proc',
    '/proc',
    '--unshare-pid',
    '--die-with-parent',
    '--tmpfs',
    spec.dataDir,
    '--bind',
    spec.hostDir,
    spec.hostDir,
  ];
  for (const dir of readOnlyDirs(spec.pluginDir)) args.push('--ro-bind', dir, dir);
  for (const dir of dirs) if (existing.has(dir)) args.push('--tmpfs', dir);
  for (const file of files) if (existing.has(file)) args.push('--ro-bind', '/dev/null', file);
  if (spec.network === null) args.push('--unshare-net');
  return args;
}

export interface WrappedLaunch {
  command: string;
  args: string[];
}

/** Wraps the host's `node ...` argv. stdin and stdout pass through the wrapper unchanged. */
export function wrapLaunch(
  detection: Extract<SandboxDetection, { kind: SandboxKind }>,
  spec: SandboxSpec,
  existing: ReadonlySet<string>,
  command: string,
  args: string[],
): WrappedLaunch {
  if (detection.kind === 'seatbelt') {
    return { command: detection.command, args: ['-p', seatbeltProfile(spec), command, ...args] };
  }
  return {
    command: detection.command,
    args: [...bwrapArgs(spec, existing), '--', command, ...args],
  };
}

/** Runs a command to completion; `true` only on exit 0. A missing binary or a timeout is `false`. */
export type SandboxProbe = (command: string, args: string[]) => Promise<boolean>;

export const defaultProbe: SandboxProbe = (command, args) =>
  new Promise<boolean>((resolve) => {
    let settled = false;
    const done = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
      done(false);
    }, 5_000);
    const child = spawn(command, args, { stdio: 'ignore' });
    child.on('error', () => done(false));
    child.on('exit', (code) => done(code === 0));
  });

const SEATBELT = '/usr/bin/sandbox-exec';

/**
 * Finds a working wrapper by RUNNING it once (a wrapper that is installed but
 * refuses to start, such as `sandbox-exec` inside another sandbox or `bwrap`
 * under a user-namespace policy, counts as unavailable).
 */
export async function detectSandbox(
  platform: NodeJS.Platform = process.platform,
  probe: SandboxProbe = defaultProbe,
): Promise<SandboxDetection> {
  if (platform === 'darwin') {
    const ok = await probe(SEATBELT, ['-p', '(version 1)(allow default)', '/usr/bin/true']);
    return ok
      ? { kind: 'seatbelt', command: SEATBELT }
      : { kind: 'unavailable', reason: 'sandbox-exec is missing or refused to start' };
  }
  if (platform === 'linux') {
    const ok = await probe('bwrap', [
      '--ro-bind',
      '/',
      '/',
      '--dev',
      '/dev',
      '--unshare-pid',
      '--die-with-parent',
      '--',
      'true',
    ]);
    return ok
      ? { kind: 'bwrap', command: 'bwrap' }
      : {
          kind: 'unavailable',
          reason: 'bwrap is not on PATH or cannot create a namespace (user namespaces disabled?)',
        };
  }
  return { kind: 'unavailable', reason: `no sandbox wrapper exists for ${platform}` };
}
