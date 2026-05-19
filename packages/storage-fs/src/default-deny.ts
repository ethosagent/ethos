import { homedir } from 'node:os';

/**
 * Non-overridable filesystem deny floor. The same shape as
 * `safety-network`'s cloud-metadata block: a personality (or a tool
 * capability) that explicitly allows `~/` cannot reach these prefixes.
 *
 * Recomputes `homedir()` per call so a test that overrides `$HOME`
 * before constructing a `ScopedStorage` / `ScopedFsImpl` sees the
 * overridden directory rather than a snapshotted one.
 *
 * Mirror of the original list in `agent-loop.ts`; lifted here so both
 * the `ScopedStorage` decorator and the capability-resolved `ScopedFs`
 * consume one source of truth.
 */
export function defaultAlwaysDeny(): string[] {
  const home = homedir();
  return [
    `${home}/.ssh`,
    `${home}/.aws/credentials`,
    `${home}/.aws/config`,
    `${home}/.gnupg`,
    `${home}/.netrc`,
    `${home}/.bash_history`,
    `${home}/.zsh_history`,
    `${home}/.psql_history`,
    `${home}/.mysql_history`,
    `${home}/.npmrc`,
    `${home}/.ethos/keys.json`,
    `${home}/.ethos/secrets`,
    `${home}/Library/Keychains`,
    '/etc/passwd',
    '/etc/shadow',
    '/etc/sudoers',
    '/etc/sudoers.d',
    '/root',
    '/boot',
    '/sys',
    '/proc/sys',
    '/proc/self/environ',
    '/proc/self/cmdline',
  ];
}
