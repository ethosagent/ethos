import type { EthosConfig } from '../config-types';
import { isOneOf, parseBoundedInt, quotedList } from './utils';

/** The two `StrictHostKeyChecking` values `execution.ssh.strictHostKeys` accepts. */
const SSH_STRICT_HOST_KEYS = ['accept-new', 'yes'] as const;

/**
 * Hostnames, IPv4, IPv6 literals (`[::1]`, `fe80::1%eth0`) and `~/.ssh/config`
 * aliases. Excludes whitespace, control characters, `@`, `/`, and every shell
 * metacharacter — a destination is an argv word, not a command.
 */
const SSH_HOST_GRAMMAR = /^[A-Za-z0-9._:%[\]-]+$/;

/** POSIX-shaped login names. Same exclusions as the host grammar. */
const SSH_USER_GRAMMAR = /^[A-Za-z0-9._-]+$/;

/**
 * Why `execution.ssh.user`/`.host` cannot be spelled into an ssh destination,
 * or `null` when they can.
 *
 * The destination is appended to ssh's OWN argv, and ssh parses any argument
 * beginning with `-` as another LOCAL option — a host of `-oProxyCommand=<cmd>`
 * runs `<cmd>` on the Ethos host, not the remote one. Verified against OpenSSH
 * 9.6p1: `ssh -G -oProxyCommand=touch /tmp/x realhost true` resolves
 * `proxycommand touch /tmp/x`.
 *
 * This is the boot-time layer. `extensions/execution-ssh` carries the other
 * two: the same grammar re-checked before spawn, and a `--` terminator ahead of
 * the destination in the argv. Duplicated — not imported — because `config` is
 * a lower layer than `extensions` and cannot import from one (ARCHITECTURE.md
 * §II); `sshDestinationError` there is the other copy and the two MUST change
 * together.
 */
/**
 * `UserKnownHostsFile` values that keep nothing: `none` is an OpenSSH literal,
 * not a path; the rest are null devices — `/dev/null` on POSIX, `nul` on
 * Windows. Compared lower-cased (see {@link sshKnownHostsError}).
 */
const SSH_NON_PERSISTENT_KNOWN_HOSTS = new Set(['none', '/dev/null', 'nul']);

/**
 * Why `execution.ssh.knownHostsFile` cannot hold a pinned host key, or `null`
 * when it can.
 *
 * `strictHostKeys` is an `'accept-new' | 'yes'` literal union precisely so
 * `no` cannot be written down: this surface will not spell host-key
 * verification off. `knownHostsFile` spells it by another route. The default
 * `accept-new` promises "learn the key on first sight, refuse it if it ever
 * changes", and the second half is bought entirely by PERSISTENCE — point
 * `UserKnownHostsFile` at `none` or at a null device and nothing is written
 * back, so every connection is a first connection and accepts whatever key is
 * offered. Silent MITM exposure, with no diagnostic anywhere.
 *
 * Rejected outright rather than downgraded to "then you must also set
 * `strictHostKeys: yes`": against a destination that keeps nothing, `yes`
 * matches NOTHING, so every connection fails. Safe and useless, and it surfaces
 * at the first tool call as an ssh error instead of here, at boot, as this one.
 *
 * `UserKnownHostsFile` takes a whitespace-separated LIST, so every token is
 * checked — a list is only as trustworthy as what ssh actually consults. A path
 * that does not exist YET is fine and must stay fine: `accept-new` creates it
 * on the first connection, which is how an operator adopts a dedicated file.
 *
 * KNOWN LIMIT: lexical. It refuses the spellings an operator would write, not
 * every path that resolves to a null device (`/dev/./null`, a symlink to it).
 *
 * This is the boot-time layer. `extensions/execution-ssh` carries the other, a
 * pre-spawn re-check. Duplicated — not imported — because `config` is a lower
 * layer than `extensions` and cannot import from one (ARCHITECTURE.md §II);
 * `sshKnownHostsError` there is the other copy and the two MUST change
 * together.
 */
function sshKnownHostsError(raw: string): string | null {
  const paths = raw.split(/\s+/).filter((p) => p.length > 0);
  if (paths.length === 0) {
    return `execution.ssh.knownHostsFile: must not be blank; omit the key to use ssh's own known_hosts.`;
  }
  for (const path of paths) {
    if (SSH_NON_PERSISTENT_KNOWN_HOSTS.has(path.toLowerCase())) {
      return (
        `execution.ssh.knownHostsFile: '${path}' cannot persist a learned host key, ` +
        'so every connection would be a first connection and accept any key offered. ' +
        "Point it at a writable file path, or omit the key to use ssh's own known_hosts."
      );
    }
  }
  return null;
}

function sshDestinationError(host: string, user: string | undefined): string | null {
  if (host.startsWith('-')) {
    return `execution.ssh.host: must not begin with '-' (got '${host}'); ssh would parse it as a local option.`;
  }
  if (!SSH_HOST_GRAMMAR.test(host)) {
    return `execution.ssh.host: contains characters that are not valid in a hostname (got '${host}').`;
  }
  if (user !== undefined) {
    if (user.startsWith('-')) {
      return `execution.ssh.user: must not begin with '-' (got '${user}'); ssh would parse it as a local option.`;
    }
    if (!SSH_USER_GRAMMAR.test(user)) {
      return `execution.ssh.user: contains characters that are not valid in a login name (got '${user}').`;
    }
  }
  return null;
}

/**
 * Item 9 — the `execution:` block.
 *
 * `docker` is resource caps: `cpu` is a positive (possibly fractional) core
 * count, `diskMb` a positive integer; out-of-range values are dropped so the
 * backend keeps its `--cpus 2` / no-quota defaults.
 *
 * `ssh` is the deployment's single remote target, and `host` is its switch —
 * no `host`, no block, and every other `execution.ssh.*` key is inert (the same
 * posture `background.pi.image` has for the Pi runner). Once a `host` IS
 * present a malformed value is a parse ERROR rather than a silent drop: a
 * dropped port or host-key policy means commands quietly run on the wrong
 * machine, or with a weaker guarantee than the operator wrote down. Each
 * message names the flat key exactly as it appears in `config.yaml`.
 *
 * A `host`/`user` that fails {@link sshDestinationError} drops the whole block
 * on top of erroring, the same as an empty `host`: those two values become
 * ssh's own argv, so a value that could begin a local option must never reach a
 * backend even if a caller ignores the errors.
 */
export function buildExecutionConfig(
  dockerKv: Record<string, string>,
  sshKv: Record<string, string>,
  rawAllowLocalFallback?: string,
  rawContainerized?: string,
): { execution: EthosConfig['execution'] | undefined; errors: string[]; warnings: string[] } {
  const docker: NonNullable<NonNullable<EthosConfig['execution']>['docker']> = {};
  const cpu = Number(dockerKv.cpu);
  if (dockerKv.cpu !== undefined && Number.isFinite(cpu) && cpu > 0) docker.cpu = cpu;
  const diskMb = Number(dockerKv.diskMb);
  if (dockerKv.diskMb !== undefined && Number.isFinite(diskMb) && diskMb > 0) {
    docker.diskMb = Math.floor(diskMb);
  }
  // A warning, not an error: the gateway exits on any parse error, and a bad
  // sandbox image must not take down chat-only personalities with it. The
  // value is DROPPED, so the backend refuses with its own actionable message
  // rather than ever running an unpinned image.
  const warnings: string[] = [];
  const rawImage = dockerKv.image;
  if (rawImage !== undefined) {
    const imageError = dockerImageRefError(rawImage);
    if (imageError) warnings.push(imageError);
    else docker.image = rawImage.trim();
  }

  const errors: string[] = [];
  let ssh: NonNullable<NonNullable<EthosConfig['execution']>['ssh']> | undefined;
  const rawHost = sshKv.host;
  if (rawHost !== undefined) {
    const host = rawHost.trim();
    const user = sshKv.user;
    const destinationError = host ? sshDestinationError(host, user) : null;
    if (!host) {
      errors.push('execution.ssh.host: must not be empty.');
    } else if (destinationError) {
      errors.push(destinationError);
    } else {
      let port: number | undefined;
      const rawPort = sshKv.port;
      if (rawPort !== undefined) {
        port = parseBoundedInt(rawPort, 1, 65535);
        if (port === undefined) {
          errors.push(
            `execution.ssh.port: must be an integer between 1 and 65535 (got '${rawPort}').`,
          );
        }
      }
      // Same shape as `strictHostKeys` below: the bad value is an ERROR and the
      // field is dropped, so a caller that ignores the errors falls back to
      // ssh's own `~/.ssh/known_hosts` — which persists, and therefore still
      // pins. Dropping the whole block (what a bad destination does) is not
      // needed here: the safe fallback is the default.
      let knownHostsFile: string | undefined;
      const rawKnownHosts = sshKv.knownHostsFile;
      if (rawKnownHosts !== undefined) {
        const knownHostsError = sshKnownHostsError(rawKnownHosts);
        if (knownHostsError) errors.push(knownHostsError);
        else knownHostsFile = rawKnownHosts;
      }
      let strictHostKeys: (typeof SSH_STRICT_HOST_KEYS)[number] | undefined;
      const rawStrict = sshKv.strictHostKeys;
      if (rawStrict !== undefined) {
        if (isOneOf(SSH_STRICT_HOST_KEYS, rawStrict)) {
          strictHostKeys = rawStrict;
        } else {
          errors.push(
            `execution.ssh.strictHostKeys: invalid value '${rawStrict}' (expected ${quotedList(SSH_STRICT_HOST_KEYS)}).`,
          );
        }
      }
      ssh = {
        host,
        ...(user ? { user } : {}),
        ...(port !== undefined ? { port } : {}),
        ...(sshKv.identityFile ? { identityFile: sshKv.identityFile } : {}),
        ...(knownHostsFile ? { knownHostsFile } : {}),
        ...(strictHostKeys ? { strictHostKeys } : {}),
        ...(sshKv.remoteWorkdir ? { remoteWorkdir: sshKv.remoteWorkdir } : {}),
      };
    }
  }

  const execution: NonNullable<EthosConfig['execution']> = {};
  // Only the literal `true` opts in: anything else keeps the refusal.
  if (rawAllowLocalFallback === 'true') execution.allowLocalFallback = true;
  if (rawContainerized === 'true') execution.containerized = true;
  if (Object.keys(docker).length > 0) execution.docker = docker;
  if (ssh) execution.ssh = ssh;
  return {
    execution: Object.keys(execution).length > 0 ? execution : undefined,
    errors,
    warnings,
  };
}

/** `<repo>@sha256:<64 lowercase hex>` — a registry host (with port), path and
 *  optional tag are allowed before the digest; whitespace and a leading `-`
 *  (which docker would parse as an option) are not. */
const DOCKER_IMAGE_REF_GRAMMAR = /^[A-Za-z0-9][A-Za-z0-9._/:-]*@sha256:[0-9a-f]{64}$/;

/**
 * Why an `execution.docker.image` value is refused, or `null` when it is a
 * digest-pinned reference. The ONE check for this key: the CLI parser above
 * and apps/web-api's settings save both call it, so the two writers cannot
 * accept different values. The docker backend's own `@sha256:` guard
 * (`buildDockerArgs`, extensions/execution-docker) stays as the last line.
 */
export function dockerImageRefError(value: string): string | null {
  const v = value.trim();
  if (DOCKER_IMAGE_REF_GRAMMAR.test(v)) return null;
  return (
    `execution.docker.image: must be digest-pinned as <image>@sha256:<64 hex digits> (got '${value}'); ` +
    'ignored, so docker-sandboxed exec tools will refuse to run until it is fixed. ' +
    'Get the digest with `docker buildx imagetools inspect <image>`.'
  );
}
