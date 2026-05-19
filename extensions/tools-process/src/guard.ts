import type { BeforeToolCallPayload, BeforeToolCallResult } from '@ethosagent/types';

// ---------------------------------------------------------------------------
// Dangerous command patterns
// ---------------------------------------------------------------------------
//
// `process_start` invokes `spawn(command, [], { shell: true })` (see
// ./spawn.ts) with an LLM-controlled `command` string — structurally identical
// to the `terminal` tool's exposure. The terminal tool ships a hardline
// blocklist via `@ethosagent/tools-terminal/src/guard.ts`; this file is the
// analog for `process_start`. The pattern list is intentionally a verbatim
// copy of the terminal guard's: the dangerous shapes are universally
// dangerous and apply equally to either entry point. Keep the two in sync
// when patterns are added.
//
// Same honest scope as the terminal guard: this is regex matching against
// the raw command string. Basic shell forms defeat it (variable indirection,
// command substitution, base64 indirection, eval). Pattern matching is the
// v1 floor that catches accidents and lazy attacks; production trust comes
// from sandbox attestation, not from this catalog.

const PATTERNS: Array<{ test: (cmd: string) => boolean; reason: string }> = [
  {
    // rm with both recursive (-r/-R) and force (-f) flags targeting / or ~
    test: (cmd) => {
      if (!/\brm\b/.test(cmd)) return false;
      if (!/-[a-zA-Z]*[rR][a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*[rR]/.test(cmd)) return false;
      return /\s(\/[\s;|&*]|\/\*|\/\s*$|~\/?[\s;|&*]|~\/\*|~\/?\s*$)/.test(cmd);
    },
    reason: 'recursive force-delete of root or home directory',
  },
  {
    // rm targeting ~/.ssh (any variant) — SSH key destruction
    test: (cmd) => /\brm\b[^&|;]*~\/\.ssh\b/.test(cmd),
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
];

// argv fs-path floor (defense-in-depth on top of the always-deny
// ScopedStorage floor). The shell can build paths in many ways the regex
// doesn't catch ($HOME/.ssh, $(pwd)/.ssh, eval, command substitution, glob),
// so this is NOT the boundary. The ScopedStorage always-deny list IS. This
// catalog catches lazy attacks that emit a literal credential path in the
// command string. Each pattern requires a path-segment boundary (/ or end of
// token) AFTER the file portion so suffix collisions like
// `.bash_history.example` don't false-positive.
const ARGV_FS_DENY_PATTERNS: Array<{ test: (cmd: string) => boolean; path: string }> = [
  { test: (cmd) => /\/\.ssh\/(?:id_|authorized|known)/.test(cmd), path: '~/.ssh/...' },
  { test: (cmd) => /\/\.aws\/credentials(?:[/\s]|$)/.test(cmd), path: '~/.aws/credentials' },
  { test: (cmd) => /\/\.gnupg(?:[/\s]|$)/.test(cmd), path: '~/.gnupg' },
  { test: (cmd) => /\/\.netrc(?:[\s]|$)/.test(cmd), path: '~/.netrc' },
  {
    test: (cmd) => /\/etc\/(?:passwd|shadow|sudoers)(?:[/\s]|$)/.test(cmd),
    path: '/etc/passwd|shadow|sudoers',
  },
  {
    test: (cmd) => /(?:^|\s|<|>|\/)\.(?:bash|zsh|psql|mysql)_history(?:[\s]|$)/.test(cmd),
    path: 'shell history file',
  },
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type DangerResult = { dangerous: false } | { dangerous: true; reason: string };

export function checkCommand(command: string): DangerResult {
  for (const { test, reason } of PATTERNS) {
    if (test(command)) return { dangerous: true, reason };
  }
  for (const { test, path } of ARGV_FS_DENY_PATTERNS) {
    if (test(command)) {
      return { dangerous: true, reason: `command targets always-deny path '${path}'` };
    }
  }
  return { dangerous: false };
}

export function createProcessGuardHook(): (
  payload: BeforeToolCallPayload,
) => Promise<Partial<BeforeToolCallResult> | null> {
  return async (payload) => {
    if (payload.toolName !== 'process_start') return null;
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
