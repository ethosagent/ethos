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
// string, which means basic shell forms defeat it: `$HOME/.ssh`,
// command substitution like `$(echo cm0gLXJmIC8K | base64 -d)`, variable
// indirection (`a=rm; b=-rf; c=/; $a $b $c`), `eval`, `xargs`-piped
// construction. The plan calls this out explicitly: pattern matching
// is the v1 floor that catches accidents and lazy attacks; production
// trust comes from sandbox attestation (Ch.4d), not from this catalog.
// Do not let future expansions of this list lull anyone into
// believing it's a sufficient defense.
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

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type DangerResult = { dangerous: false } | { dangerous: true; reason: string };

export function checkCommand(command: string): DangerResult {
  for (const { test, reason } of PATTERNS) {
    if (test(command)) return { dangerous: true, reason };
  }
  return { dangerous: false };
}

export function createTerminalGuardHook(): (
  payload: BeforeToolCallPayload,
) => Promise<Partial<BeforeToolCallResult> | null> {
  return async (payload) => {
    if (payload.toolName !== 'terminal') return null;
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
