import { spawn as nodeSpawn } from 'node:child_process';
import type { ProcessResult, ScopedProcess, SpawnOpts } from '@ethosagent/types';

/**
 * Host env vars a spawned child inherits. The full `process.env` carries the
 * host's secrets — provider API keys, bot tokens, and every `~/.ethos/.env`
 * entry `loadDotEnv` copied in (`packages/storage-fs/src/env-secrets.ts`) — so
 * a prompt-injected `curl …?k=$ANTHROPIC_API_KEY` would ship them off the
 * machine. Only the minimum a shell and common toolchains need is forwarded.
 *
 * The same allowlist (`PASSTHROUGH_ENV_KEYS`, `PASSTHROUGH_ENV_PREFIXES`,
 * `SECRET_ENV_NAME`, `isPassthroughEnvKey`) as
 * `extensions/tools-process/src/spawn.ts`,
 * `extensions/execution-local/src/index.ts` and
 * `extensions/execution-process-backend/src/index.ts`, copied rather than
 * imported (core cannot import extensions, and the extensions depend only on
 * types). The four change together. Pinned by `scoped-process-lifetime.test.ts`
 * ('env allowlist (V-ES-8)').
 */
const PASSTHROUGH_ENV_KEYS: ReadonlySet<string> = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'TERM',
  'COLORTERM',
  'TMPDIR',
  'TZ',
  // V-ES-8: without these `git push` over ssh, a corporate proxy, the locale
  // macOS sets (LC_CTYPE only) and the common toolchain roots all break.
  'SSH_AUTH_SOCK',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'all_proxy',
  'NODE_PATH',
  'GOPATH',
  'GOROOT',
  'GOBIN',
  'JAVA_HOME',
  'CARGO_HOME',
  'RUSTUP_HOME',
  'PYENV_ROOT',
  'PYTHONPATH',
  'VIRTUAL_ENV',
]);
/** Whole families forwarded by prefix: locale, nvm, conda, XDG dirs, terminal identity. */
const PASSTHROUGH_ENV_PREFIXES = ['LC_', 'NVM_', 'CONDA_', 'XDG_', 'TERM_'] as const;
/** A name that looks like a credential is never forwarded, even inside an allowed family. */
const SECRET_ENV_NAME = /KEY|TOKEN|SECRET|PASSW|CREDENTIAL|(?:^|_)API(?:_|$)|^AWS_/i;

/**
 * True when `key` may pass from the host env to a child. Names `loadDotEnv`
 * copied in from `~/.ethos/.env` (recorded in `ETHOS_DOTENV_KEYS`,
 * packages/storage-fs/src/env-secrets.ts) never pass, whatever they are.
 */
function isPassthroughEnvKey(key: string, dotenvKeys: ReadonlySet<string>): boolean {
  if (dotenvKeys.has(key) || SECRET_ENV_NAME.test(key)) return false;
  return PASSTHROUGH_ENV_KEYS.has(key) || PASSTHROUGH_ENV_PREFIXES.some((p) => key.startsWith(p));
}

/** The passthrough allowlist drawn from `process.env`, with `env` merged on top (explicit wins). */
export function minimalHostEnv(env: Record<string, string> | undefined): Record<string, string> {
  const base: Record<string, string> = {};
  const dotenvKeys = new Set((process.env.ETHOS_DOTENV_KEYS ?? '').split(',').filter(Boolean));
  for (const [key, val] of Object.entries(process.env)) {
    if (val !== undefined && isPassthroughEnvKey(key, dotenvKeys)) base[key] = val;
  }
  return env ? { ...base, ...env } : base;
}

/** SIGTERM → SIGKILL grace after a timeout or abort. */
const KILL_GRACE_MS = 2_000;
/**
 * How long to wait, after the direct child exits, for its output pipes to
 * close. A descendant still holding them past this (`npm run dev &` with no
 * redirection) would otherwise keep the call open until it dies — forever for
 * a server — so the group is killed and the call resolves with what it has.
 */
const EXIT_DRAIN_MS = 500;
/** Exit code reported for a timed-out command (GNU `timeout`'s convention). */
const TIMEOUT_EXIT_CODE = 124;

/**
 * Host process capability.
 *
 * Lifetime (UBP-007/042): the child is spawned in its own process group
 * (`detached`, POSIX), and a timeout or an aborted `signal` signals the WHOLE
 * group — SIGTERM, then SIGKILL after {@link KILL_GRACE_MS} — so grandchildren
 * a shell started die with it. The call resolves on the child's exit plus a
 * bounded drain ({@link EXIT_DRAIN_MS}), never on `close` alone. A timeout
 * resolves with exit {@link TIMEOUT_EXIT_CODE} and a note on stderr; an abort
 * rejects with an `ABORTED:` error. On Windows there are no process groups:
 * only the direct child is signalled.
 *
 * Env (UBP-048): {@link minimalHostEnv} unless the caller sets `inheritEnv`.
 *
 * Pinned by `packages/core/src/__tests__/scoped-process-lifetime.test.ts`.
 */
export class ScopedProcessImpl implements ScopedProcess {
  constructor(private readonly allowedBinaries: Set<string>) {}

  async spawn(binary: string, args: string[], opts?: SpawnOpts): Promise<ProcessResult> {
    if (!this.allowedBinaries.has('*') && !this.allowedBinaries.has(binary)) {
      throw new Error(`BINARY_NOT_ALLOWED: ${binary} is not in the declared allowedBinaries`);
    }
    const signal = opts?.signal;
    if (signal?.aborted) throw new Error(`ABORTED: ${binary} was not started`);

    return new Promise((resolve, reject) => {
      const useGroup = process.platform !== 'win32';
      const child = nodeSpawn(binary, args, {
        cwd: opts?.cwd,
        env: opts?.inheritEnv ? { ...process.env, ...opts.env } : minimalHostEnv(opts?.env),
        detached: useGroup,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));

      let settled = false;
      let stopReason: 'timeout' | 'abort' | null = null;
      let exitCode: number | null = null;
      const timers: ReturnType<typeof setTimeout>[] = [];

      const signalGroup = (sig: NodeJS.Signals): void => {
        const pid = child.pid;
        if (pid === undefined) return;
        try {
          if (useGroup) process.kill(-pid, sig);
          else child.kill(sig);
        } catch {
          // ESRCH: every member of the group has already exited — nothing to signal.
        }
      };

      const onAbort = (): void => stop('abort');

      const finish = (err?: Error): void => {
        if (settled) return;
        settled = true;
        for (const t of timers) clearTimeout(t);
        signal?.removeEventListener('abort', onAbort);
        // A stopped command leaves nothing behind, even a member that ignored
        // SIGTERM or redirected away from our pipes.
        if (stopReason !== null) signalGroup('SIGKILL');
        child.stdout.destroy();
        child.stderr.destroy();
        if (err) {
          reject(err);
          return;
        }
        if (stopReason === 'abort') {
          reject(new Error(`ABORTED: ${binary} was stopped and its process group killed`));
          return;
        }
        const out = Buffer.concat(stdout).toString();
        const errText = Buffer.concat(stderr).toString();
        if (stopReason === 'timeout') {
          const sep = errText && !errText.endsWith('\n') ? '\n' : '';
          resolve({
            exitCode: TIMEOUT_EXIT_CODE,
            stdout: out,
            stderr: `${errText}${sep}[timed out after ${opts?.timeout}ms; process group killed]`,
          });
          return;
        }
        resolve({ exitCode: exitCode ?? 1, stdout: out, stderr: errText });
      };

      function stop(reason: 'timeout' | 'abort'): void {
        if (settled || stopReason !== null) return;
        stopReason = reason;
        signalGroup('SIGTERM');
        timers.push(setTimeout(() => finish(), KILL_GRACE_MS));
      }

      const timeout = opts?.timeout;
      if (timeout !== undefined && timeout > 0) {
        timers.push(setTimeout(() => stop('timeout'), timeout));
      }
      signal?.addEventListener('abort', onAbort, { once: true });

      child.on('error', (err) => finish(err));
      child.on('exit', (code) => {
        exitCode = code;
        // The direct child is gone; give its pipes a bounded window to close,
        // then kill whatever in its group is still holding them.
        timers.push(
          setTimeout(() => {
            signalGroup('SIGKILL');
            finish();
          }, EXIT_DRAIN_MS),
        );
      });
      child.on('close', () => finish());
    });
  }
}
