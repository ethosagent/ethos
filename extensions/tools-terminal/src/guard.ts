import { homedir } from 'node:os';
import { join } from 'node:path';
import { ethosStateDirs, sensitiveDenyPaths } from '@ethosagent/storage-fs';
import type { BeforeToolCallPayload, BeforeToolCallResult } from '@ethosagent/types';

// ---------------------------------------------------------------------------
// Dangerous command patterns
// ---------------------------------------------------------------------------

// Ch.4a — Hardline blocklist (non-overridable, best-effort).
//
// These patterns ALWAYS block when matched, regardless of personality
// config, approval mode, or user override. Lives in code, not config —
// the user cannot remove or whitelist any of these.
//
// **Honest scope.** This is regex matching against the raw command
// string. The inline-eval wrappers (`sh -c` and its siblings, `eval`,
// `python -c`, `node -e`, anything piped into a shell, `$(…)` and
// backticks, case-variant `rm`) are hardline since D1(b) of plan
// openclaw-2026.9.6-gaps — the entries at the end of PATTERNS. What STILL
// defeats it, and is not caught:
//   - variable indirection: `a=rm; b=-rf; c=/; $a $b $c`
//   - other interpreters' eval flags: `perl -e`, `ruby -e`, `php -r`,
//     `awk 'BEGIN{system(…)}'`, `find -exec`, `xargs rm`
//   - process substitution and here-docs/here-strings fed to a shell:
//     `sh <(…)`, `bash <<< "…"`, `sh script-the-agent-just-wrote.sh`
//   - quoting inside a word: `r''m -rf /`
//   - relative paths to protected files: `cd ~; cat .ssh/id_rsa`
// The plan calls this out explicitly: pattern matching is the v1 floor that
// catches accidents and lazy attacks; production trust comes from sandbox
// attestation (Ch.4d), not from this catalog. Do not let future expansions
// of this list lull anyone into believing it's a sufficient defense.
//
// The reason the regex floor is still worth shipping: it bounds the
// blast radius of an LLM that fluently wrote `rm -rf /` in plain shell.
// CVE-2026-29607 in OpenClaw was an approval-bypass that destroyed
// prod data; a non-overridable regex floor would have caught the
// literal command shape even with approval bypassed.
const PATTERNS: Array<{ test: (cmd: string) => boolean; reason: string }> = [
  {
    // rm with both recursive (-r/-R) and force (-f) flags targeting / or ~
    test: (cmd) => {
      // Case-insensitive (D1b): `RM`/`Rm` resolve to rm on a case-insensitive filesystem.
      if (!/\brm\b/i.test(cmd)) return false;
      if (!/-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r/i.test(cmd)) return false;
      return /\s(\/[\s;|&*]|\/\*|\/\s*$|~\/?[\s;|&*]|~\/\*|~\/?\s*$)/.test(cmd);
    },
    reason: 'recursive force-delete of root or home directory',
  },
  {
    // rm targeting ~/.ssh (any variant) — SSH key destruction
    test: (cmd) => /\brm\b[^&|;]*~\/\.ssh\b/i.test(cmd),
    reason: 'SSH key directory destruction',
  },
  {
    // gpg --delete-secret-keys — GPG private key destruction
    test: (cmd) => /\bgpg\b[^&|;]*--delete-secret-keys?/.test(cmd),
    reason: 'GPG secret key destruction',
  },
  {
    // find / -delete — system-wide find-and-delete
    test: (cmd) => /\bfind\b[^&|;]*\s\/\s[^&|;]*-delete\b/.test(cmd),
    reason: 'find-and-delete on root',
  },
  {
    // dd writing to a block device (of=/dev/sdX, /dev/nvmeX, etc.)
    test: (cmd) => /\bdd\b/.test(cmd) && /\bof=\/dev\/[a-z]/.test(cmd),
    reason: 'direct write to a block device',
  },
  {
    // Any mkfs variant
    test: (cmd) => /\bmkfs(\.[a-z]+)?\b/.test(cmd),
    reason: 'filesystem format operation',
  },
  {
    // Redirect output to a block device
    test: (cmd) => />\s*\/dev\/(?:sd|hd|vd|xvd|nvme)[a-z0-9]/.test(cmd),
    reason: 'overwriting a block device',
  },
  {
    // Fork bomb: :(){:|:&};:
    test: (cmd) => /:\s*\(\s*\)\s*\{/.test(cmd),
    reason: 'fork bomb',
  },
  {
    // chmod with setuid/setgid — privilege escalation primitive
    test: (cmd) => /\bchmod\b[^&|;]*\b(?:[4267]\d{3}|u\+s|g\+s)\b/.test(cmd),
    reason: 'setuid/setgid permission grant',
  },
  {
    // setcap with capability flags
    test: (cmd) => /\bsetcap\b[^&|;]*\bcap_/.test(cmd),
    reason: 'capability grant via setcap',
  },
  {
    // Writes to /etc/sudoers, /etc/passwd, /etc/shadow
    test: (cmd) => />\s*\/etc\/(?:sudoers|passwd|shadow)\b/.test(cmd),
    reason: 'overwrite of system auth file',
  },
  {
    // Writes to /boot/, /sys/, /proc/sys/
    test: (cmd) => />\s*\/(?:boot|sys|proc\/sys)\//.test(cmd),
    reason: 'kernel/boot tampering',
  },
  {
    // Overwriting authorized_keys
    test: (cmd) => />\s*~?\/?\.?ssh\/authorized_keys\b/.test(cmd),
    reason: 'authorized_keys overwrite',
  },
  {
    // SQL: DROP DATABASE / DROP TABLE / DROP SCHEMA
    test: (cmd) => /\bdrop\s+(database|table|schema)\b/i.test(cmd),
    reason: 'destructive SQL DDL (DROP)',
  },
  {
    // SQL: TRUNCATE TABLE
    test: (cmd) => /\btruncate\s+table\b/i.test(cmd),
    reason: 'destructive SQL DDL (TRUNCATE)',
  },
  // D1(b) — inline-eval wrappers (plan openclaw-2026.9.6-gaps S6). Each one
  // hands the shell a string the patterns above never see as a command, so the
  // wrapper itself is the hardline shape, whatever it wraps.
  {
    // bash/sh/zsh/dash/ksh/fish -c '<string>' (also -lc, -ec, /bin/sh -c,
    // `xargs sh -c`). `ssh -c <cipher>` does not match: the `sh` must start a word.
    test: (cmd) =>
      /(?:^|[\s;&|(`/])(?:ba|z|da|k|fi)?sh\s+(?:-[a-zA-Z]+\s+)*-[a-zA-Z]*c\b/.test(cmd),
    reason: 'inline shell eval (sh -c)',
  },
  {
    // eval in command position (start, after an operator, or after a wrapper).
    test: (cmd) =>
      /(?:^|[;&|({`\n]|\b(?:sudo|exec|xargs|env|command|builtin|nohup|time)\s)\s*eval\b/.test(cmd),
    reason: 'inline shell eval (eval)',
  },
  {
    // python -c '<code>' / python3 -c
    test: (cmd) => /\bpython[0-9.]*\s+(?:-[a-zA-Z]+\s+)*-[a-zA-Z]*c\b/.test(cmd),
    reason: 'inline interpreter eval (python -c)',
  },
  {
    // node -e / -p / --eval / --print
    test: (cmd) => /\bnode\s+(?:-[-a-zA-Z]+\s+)*(?:-[a-zA-Z]*[ep]\b|--eval\b|--print\b)/.test(cmd),
    reason: 'inline interpreter eval (node -e)',
  },
  {
    // Anything piped into a shell — the form a `base64 -d` payload takes to
    // run. Matched on the pipe's target, not on `base64`, because the decoder
    // has many spellings (`openssl base64 -d`, `xxd -r`, `printf '\x..'`).
    test: (cmd) => /\|\s*(?:sudo\s+)?(?:\S*\/)?(?:ba|z|da|k|fi)?sh(?:\s|$)/.test(cmd),
    reason: 'input piped into a shell',
  },
  {
    // Command substitution: $(…) and backticks. `$((…))` is arithmetic and
    // runs nothing, so it is excluded.
    test: (cmd) => /\$\((?!\()/.test(cmd) || /`[^`]*`/.test(cmd),
    reason: 'command substitution',
  },
];

// Ch.5 — bash argv fs-path floor (defense-in-depth on top of the
// always-deny ScopedStorage floor). The shell can build paths in many
// ways the regex doesn't catch (`$HOME/.ssh`, `$(pwd)/.ssh`, `eval`,
// command substitution, glob), so this is NOT the boundary. The
// ScopedStorage always-deny list IS. This catalog catches lazy attacks
// that emit a literal credential path in the command string.
// Match a credential path no matter where it appears in the command —
// `cat ~/.ssh/id_rsa`, `cat /home/u/.ssh/id_rsa`, `head < /etc/passwd`,
// all should fire. Each pattern requires a path-segment boundary
// (`/` or end of token) AFTER the file portion so suffix collisions
// like `.bash_history.example` don't false-positive.
//
// Each entry's `paths` are selected from the canonical `sensitiveDenyPaths()`
// manifest rather than re-hardcoded, so the deny set stays single-sourced.
// The argv floor covers only the subset of the manifest a regex can safely
// match in an arbitrary shell string; the parity test asserts every path
// here is a manifest member.
function denyPathsEndingWith(...suffixes: string[]): string[] {
  const deny = sensitiveDenyPaths();
  return suffixes.flatMap((suffix) => deny.filter((p) => p === suffix || p.endsWith(suffix)));
}

export const ARGV_FS_DENY_PATTERNS: Array<{ test: (cmd: string) => boolean; paths: string[] }> = [
  {
    test: (cmd) => /\/\.ssh\/(?:id_|authorized|known)/.test(cmd),
    paths: denyPathsEndingWith('/.ssh'),
  },
  {
    test: (cmd) => /\/\.aws\/credentials(?:[/\s]|$)/.test(cmd),
    paths: denyPathsEndingWith('/.aws/credentials'),
  },
  { test: (cmd) => /\/\.gnupg(?:[/\s]|$)/.test(cmd), paths: denyPathsEndingWith('/.gnupg') },
  { test: (cmd) => /\/\.netrc(?:[\s]|$)/.test(cmd), paths: denyPathsEndingWith('/.netrc') },
  {
    test: (cmd) => /\/etc\/(?:passwd|shadow|sudoers)(?:[/\s]|$)/.test(cmd),
    paths: denyPathsEndingWith('/etc/passwd', '/etc/shadow', '/etc/sudoers'),
  },
  {
    test: (cmd) => /(?:^|\s|<|>|\/)\.(?:bash|zsh|psql|mysql)_history(?:[\s]|$)/.test(cmd),
    paths: denyPathsEndingWith('_history'),
  },
];

// S16 — the Ethos state dir on the argv floor. A command that names a state
// dir at all is refused: on local posture the shell runs as the Ethos user and
// no Storage mediates it, so this is the only check between the agent and its
// own `toolset.yaml` (hot-reloaded next turn), `config.yaml`, `mcp.json` and
// every personality's `sessions.db`. The dirs come from `ethosStateDirs()` —
// the same roster module (`packages/storage-fs/src/sensitive-paths.ts`) whose
// entries ScopedStorage and ScopedFs deny — so the two cannot drift.
//
// Wider than the always-deny roster on purpose: the roster must leave the
// personality's own directory reachable (MEMORY.md), but a shell that reaches
// the state dir can edit the definition files beside it, which only Storage's
// write-deny list protects. Same honest scope as everything above: `cd ~;
// sed -i … .ethos/…`, `$(printf ~)/.ethos` or a variable holding the path all
// pass. `execution: docker` is the boundary.
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// A path ends at `/`, whitespace, a quote, a shell operator or end of string.
const PATH_END = '(?=[/\\s\'"`;|&)]|$)';

export function stateDirReference(cmd: string): string | null {
  const defaultDir = join(homedir(), '.ethos');
  for (const dir of ethosStateDirs()) {
    const spellings = [escapeRegExp(dir)];
    if (dir === defaultDir) spellings.push(String.raw`(?:~|\$HOME|\$\{HOME\})/\.ethos`);
    if (new RegExp(`(?:${spellings.join('|')})${PATH_END}`).test(cmd)) return dir;
  }
  if (/\$\{?ETHOS_STATE_DIR\b/.test(cmd)) return '$ETHOS_STATE_DIR';
  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type DangerResult = { dangerous: false } | { dangerous: true; reason: string };

export function checkCommand(command: string): DangerResult {
  for (const { test, reason } of PATTERNS) {
    if (test(command)) return { dangerous: true, reason };
  }
  for (const { test, paths } of ARGV_FS_DENY_PATTERNS) {
    if (test(command)) {
      return { dangerous: true, reason: `command targets always-deny path '${paths.join(', ')}'` };
    }
  }
  const stateDir = stateDirReference(command);
  if (stateDir)
    return { dangerous: true, reason: `command names the Ethos state dir '${stateDir}'` };
  return { dangerous: false };
}

/**
 * The hard-blocking `before_tool_call` guard. Checks `args.command` of every
 * tool named in `toolNames` (default: `terminal` only). Wiring passes
 * `TERMINAL_CHECKED_TOOLS` (packages/wiring/src/danger-predicate.ts) so
 * `run_tests` / `lint`, whose `command` also reaches `bash -c`, are blocked by
 * the same rules (EXE-001).
 */
export function createTerminalGuardHook(
  toolNames: ReadonlyArray<string> = ['terminal'],
): (payload: BeforeToolCallPayload) => Promise<Partial<BeforeToolCallResult> | null> {
  return async (payload) => {
    if (!toolNames.includes(payload.toolName)) return null;
    const args = payload.args as { command?: string };
    if (!args.command) return null;
    const result = checkCommand(args.command);
    if (result.dangerous) {
      return {
        error: `Command blocked: ${result.reason}. This operation requires explicit human approval before proceeding.`,
      };
    }
    return null;
  };
}
