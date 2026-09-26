import { homedir } from 'node:os';
import { join } from 'node:path';
import { ethosStateDirs, sensitiveDenyPaths } from '@ethosagent/storage-fs';
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
// dangerous and apply equally to either entry point. The same goes for
// APPROVAL_PATTERNS (command substitution, which asks rather than refuses)
// and the inline-eval tokenizer (`inlineEvalReason`). Keep the two files in
// sync when patterns are added.
//
// Same honest scope as the terminal guard: regex matching against the raw
// command string plus a small argv tokenizer for the inline-eval wrappers
// (D1b), and the terminal guard's header lists what still defeats both.
// Pattern matching is the v1 floor that catches accidents and lazy attacks;
// production trust comes from sandbox attestation, not from this catalog.

const PATTERNS: Array<{ test: (cmd: string) => boolean; reason: string }> = [
  {
    // rm with both recursive (-r/-R) and force (-f) flags targeting / or ~
    test: (cmd) => {
      // Case-insensitive (D1b): `RM`/`Rm` resolve to rm on a case-insensitive filesystem.
      if (!/\brm\b/i.test(cmd)) return false;
      if (!/-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r/i.test(cmd)) return false;
      // `)` and a backtick end the path too: `echo $(rm -rf /)` is still this
      // shape now that the substitution around it only asks (see APPROVAL_PATTERNS).
      return /\s(\/[\s;|&*)`]|\/\*|\/\s*$|~\/?[\s;|&*)`]|~\/\*|~\/?\s*$)/.test(cmd);
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
];

// ---------------------------------------------------------------------------
// D1(b) — inline-eval wrappers (plan openclaw-2026.9.6-gaps S6), read from argv
// ---------------------------------------------------------------------------
//
// Each wrapper hands the shell a string the patterns above never see as a
// command, so the wrapper itself is the hardline shape, whatever it wraps.
// Regexes over the raw string were bypassed by an eval flag that was not the
// first option (`bash -o pipefail -c`), a wrapper in front of a pipe's shell
// (`| env bash`) and `eval` after a keyword (`then eval`). So the command is
// split into simple commands (`splitSimpleCommands`) and each argv is read:
//   - `sh`/`bash`/`zsh`/`dash`/`ksh`/`fish` with `c` in any short-option
//     cluster before the first operand (`-c`, `-ec`, `-xc`), options that take
//     a word skipped (`-o pipefail`, `--rcfile f`), or fish's `--command`;
//   - `python*` with `-c` under getopt rules (`-Bc`, `-W ignore -c`), `-m`
//     ending the scan; `node` with `-e`/`-p`/`--eval`/`--print`, `-r x` and
//     the arg-taking long options in NODE_ARG_LONG skipped. Scope stops there
//     (D1): `perl -e`/`ruby -e`/`php -r` are NOT hardline — `perl -pi -e` is a
//     routine in-place edit, and blocking it with no approval path costs more
//     than the floor it adds.
//   The interpreter checks run at EVERY word of a simple command, not only its
//   head: the commands that run their arguments (`docker exec`, `uv run`,
//   `kubectl exec --`, `watch`, `su -c`…) are an open-ended list. The cost is
//   a false positive when a word that is exactly an interpreter's name is
//   followed by its eval flag as another program's argument (`grep bash -c f`).
//   - `eval` as the command, after leading `VAR=x` assignments, shell keywords
//     (`then`, `do`, `else`, `{`, `!`…) and the wrappers in WRAPPERS
//     (`sudo -u root`, `env -i`, `timeout 5`, `nice -n 5`, `xargs -0`…), with
//     absolute paths reduced to their basename. Head position only: `make
//     eval`, `pytest -k eval` are not flagged.
//   - a shell that is the head (same unwrapping) of a command fed by `|`/`|&`
//     — the form a `base64 -d` payload takes to run, matched on the pipe's
//     target because the decoder has many spellings. `| xargs sh` is not this
//     shape: xargs turns stdin into arguments, not a script.
// Names are compared lower-cased: `BASH` resolves to bash on a
// case-insensitive filesystem, the same reason `rm` is matched with /i above.

interface SimpleCommand {
  /** Words with quoting removed; redirection operators and their targets dropped. */
  words: string[];
  /** True when this command reads the previous one's output through `|` or `|&`. */
  piped: boolean;
}

/**
 * Split a shell string into simple commands: at `;`, `&`, `&&`, `|`, `||`,
 * `|&`, newline, `(`, `)`, and at both ends of every `$(…)` and backtick
 * substitution (including one inside double quotes), so each nested command
 * is a simple command of its own. Quotes are honoured and removed; a
 * backslash escapes the next character. Not a shell parser: no expansion, no
 * here-doc bodies (their lines read as commands, which errs toward flagging),
 * no `case` patterns, no brace/`${…}` grouping.
 */
export function splitSimpleCommands(cmd: string): SimpleCommand[] {
  const out: SimpleCommand[] = [];
  let words: string[] = [];
  let word = '';
  let inWord = false;
  let quote: '' | "'" | '"' = '';
  let piped = false;
  let dropNextWord = false;
  // One frame per open `$(` or backtick: the quote state to restore when it
  // closes, and the depth of unquoted `(` opened inside it.
  const frames: Array<{ restore: '' | '"'; depth: number; tick: boolean }> = [];

  const endWord = () => {
    if (inWord) {
      if (dropNextWord) dropNextWord = false;
      else words.push(word);
    }
    word = '';
    inWord = false;
  };
  const endCommand = (nextPiped: boolean) => {
    endWord();
    if (words.length > 0) out.push({ words, piped });
    words = [];
    piped = nextPiped;
    dropNextWord = false;
  };
  const open = (tick: boolean) => {
    endCommand(false);
    frames.push({ restore: quote === '"' ? '"' : '', depth: 0, tick });
    quote = '';
  };
  const close = () => {
    endCommand(false);
    quote = frames.pop()?.restore ?? '';
  };
  const redirect = (i: number): number => {
    // `2>` / `&>` / `>>` / `>&` / `<<<`: drop the operator and its target word.
    if (inWord && /^\d+$/.test(word)) {
      word = '';
      inWord = false;
    } else endWord();
    let j = i;
    while ('<>&'.includes(cmd[j + 1] ?? '|')) j++;
    dropNextWord = true;
    return j;
  };

  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i] ?? '';
    const next = cmd[i + 1] ?? '';
    if (quote === "'") {
      if (c === "'") quote = '';
      else word += c;
      continue;
    }
    if (c === '\\') {
      if (next === '\n') i++;
      else if (quote === '"' && !'"\\$`'.includes(next)) word += c;
      else {
        word += next;
        i++;
      }
      inWord = true;
      continue;
    }
    if (c === '$' && next === '(') {
      i++;
      open(false);
      continue;
    }
    if (c === '`') {
      if (frames[frames.length - 1]?.tick) close();
      else open(true);
      continue;
    }
    if (quote === '"') {
      if (c === '"') quote = '';
      else word += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      inWord = true;
    } else if (c === ' ' || c === '\t' || c === '\r') endWord();
    else if (c === '\n' || c === ';') endCommand(false);
    else if (c === '|') {
      if (next === '|' || next === '&') i++;
      endCommand(next !== '|');
    } else if (c === '&') {
      if (next === '>') i = redirect(i);
      else {
        if (next === '&') i++;
        endCommand(false);
      }
    } else if (c === '<' || c === '>') i = redirect(i);
    else if (c === '(') {
      const top = frames[frames.length - 1];
      if (top && !top.tick) top.depth++;
      endCommand(false);
    } else if (c === ')') {
      const top = frames[frames.length - 1];
      if (top && !top.tick && top.depth === 0) close();
      else {
        if (top && !top.tick) top.depth--;
        endCommand(false);
      }
    } else {
      word += c;
      inWord = true;
    }
  }
  endCommand(false);
  return out;
}

const SHELL_NAME = /^(?:ba|z|da|k|fi)?sh$/;
const PYTHON_NAME = /^python[0-9.]*$/;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;
const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{']);
// Commands that run the rest of their argv as a command: the short options
// and long options that consume the next word, and fixed operands before the
// command (timeout's DURATION).
const WRAPPERS: Record<string, { short: string; long: string[]; operands?: number }> = {
  env: { short: 'uCS', long: ['--unset', '--chdir', '--split-string'] },
  sudo: {
    short: 'ugpChDrtTUR',
    long: [
      '--user',
      '--group',
      '--prompt',
      '--host',
      '--chdir',
      '--role',
      '--type',
      '--other-user',
    ],
  },
  command: { short: '', long: [] },
  builtin: { short: '', long: [] },
  exec: { short: 'a', long: [] },
  nice: { short: 'n', long: ['--adjustment'] },
  nohup: { short: '', long: [] },
  time: { short: 'fo', long: ['--format', '--output'] },
  timeout: { short: 'sk', long: ['--signal', '--kill-after'], operands: 1 },
  xargs: {
    short: 'adEILnPs',
    long: ['--arg-file', '--delimiter', '--max-lines', '--max-args', '--max-procs', '--max-chars'],
  },
};
// node options whose value may be the next word (`--input-type module`).
const NODE_ARG_LONG = new Set([
  '--require',
  '--import',
  '--loader',
  '--experimental-loader',
  '--input-type',
  '--conditions',
  '--env-file',
  '--title',
  '--disable-warning',
  '--watch-path',
]);

const commandName = (word: string): string => (word.split('/').pop() ?? word).toLowerCase();

/** Index of the first word after `words[i..]`'s options (getopt rules). */
function skipOptions(words: string[], i: number, short: string, long: string[]): number {
  let k = i;
  while (k < words.length) {
    const w = words[k] ?? '';
    if (w === '--') return k + 1;
    if (!w.startsWith('-') || w === '-') return k;
    k++;
    if (w.startsWith('--')) {
      if (!w.includes('=') && long.includes(w)) k++;
      continue;
    }
    for (let j = 1; j < w.length; j++) {
      if (short.includes(w[j] ?? '')) {
        if (j === w.length - 1) k++;
        break;
      }
    }
  }
  return k;
}

/** The command a simple command runs once assignments, keywords and wrappers are peeled off. */
function commandHead(words: string[]): { name: string; viaXargs: boolean } | null {
  let i = 0;
  let viaXargs = false;
  for (;;) {
    while (i < words.length && (ASSIGNMENT.test(words[i] ?? '') || KEYWORDS.has(words[i] ?? ''))) {
      i++;
    }
    const head = words[i];
    if (head === undefined) return null;
    const name = commandName(head);
    const wrapper = WRAPPERS[name];
    if (!wrapper) return { name, viaXargs };
    if (name === 'xargs') viaXargs = true;
    i = skipOptions(words, i + 1, wrapper.short, wrapper.long) + (wrapper.operands ?? 0);
  }
}

function shellEvalFlag(args: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const w = args[i] ?? '';
    if (w.startsWith('--')) {
      if (w === '--command' || w.startsWith('--command=')) return true;
      if (w === '--') return false;
      if (w === '--rcfile' || w === '--init-file') i++;
      continue;
    }
    if (!/^[-+][A-Za-z]+$/.test(w)) return false;
    if (w.startsWith('-') && w.includes('c')) return true;
    // bash reads `-o`/`-O`'s argument from the NEXT word, one per letter.
    for (const ch of w) if (ch === 'o' || ch === 'O') i++;
  }
  return false;
}

function pythonEvalFlag(args: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const w = args[i] ?? '';
    if (w === '--' || w === '-' || !w.startsWith('-')) return false;
    if (w.startsWith('--')) {
      if (w === '--check-hash-based-pycs') i++;
      continue;
    }
    for (let j = 1; j < w.length; j++) {
      const ch = w[j];
      if (ch === 'c') return true;
      if (ch === 'm') return false;
      if (ch === 'W' || ch === 'X') {
        if (j === w.length - 1) i++;
        break;
      }
    }
  }
  return false;
}

function nodeEvalFlag(args: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const w = args[i] ?? '';
    if (w === '--' || w === '-' || !w.startsWith('-')) return false;
    if (w.startsWith('--')) {
      const name = w.split('=')[0];
      if (name === '--eval' || name === '--print') return true;
      if (!w.includes('=') && NODE_ARG_LONG.has(w)) i++;
      continue;
    }
    if (/[ep]/.test(w)) return true;
    if (w === '-r' || w === '-C') i++;
  }
  return false;
}

/** The inline-eval wrapper `command` uses, or `null`. See the section comment above. */
export function inlineEvalReason(command: string): string | null {
  for (const { words, piped } of splitSimpleCommands(command)) {
    for (let i = 0; i < words.length; i++) {
      const name = commandName(words[i] ?? '');
      const args = words.slice(i + 1);
      if (SHELL_NAME.test(name) && shellEvalFlag(args)) return 'inline shell eval (sh -c)';
      if (PYTHON_NAME.test(name) && pythonEvalFlag(args)) {
        return 'inline interpreter eval (python -c)';
      }
      if ((name === 'node' || name === 'nodejs') && nodeEvalFlag(args)) {
        return 'inline interpreter eval (node -e)';
      }
    }
    const head = commandHead(words);
    if (head?.name === 'eval') return 'inline shell eval (eval)';
    if (piped && head && !head.viaXargs && SHELL_NAME.test(head.name)) {
      return 'input piped into a shell';
    }
  }
  return null;
}

// Approval-required, NOT hardline: shapes a human may reasonably want to run
// (`kill $(lsof -t -i:3000)`, a commit message built with `$(cat msg)`) but
// that hide what actually executes from every pattern above. `checkCommand`
// does not refuse them; `approvalRequiredReason` names them, and
// - the danger predicate (`createDangerPredicate`,
//   packages/wiring/src/danger-predicate.ts) flags them in every approval
//   mode, so a surface with a human asks and a surface without one refuses;
// - the guard hook below refuses them on a loop no approval gate covers
//   (CLI, TUI, ACP) — fail closed — and leaves them to the gate on a loop
//   that has one (`approvalGated`, wired by `composeAllTools` from
//   `hasHostApprovalGate`).
// Command substitution was hardline under D1(b) of plan
// openclaw-2026.9.6-gaps; it moved here because hardline has no approval path.
const APPROVAL_PATTERNS: Array<{ test: (cmd: string) => boolean; reason: string }> = [
  {
    // Command substitution: $(…) and backticks. `$((…))` is arithmetic and
    // runs nothing, so it is excluded.
    test: (cmd) => /\$\((?!\()/.test(cmd) || /`[^`]*`/.test(cmd),
    reason: 'command substitution',
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
//
// Each entry's `paths` are selected from the canonical `sensitiveDenyPaths()`
// manifest rather than re-hardcoded, so this floor and the terminal guard's
// share one source of truth (the paths can no longer drift out of sync). The
// parity test asserts every path here is a manifest member.
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
  const evalReason = inlineEvalReason(command);
  if (evalReason) return { dangerous: true, reason: evalReason };
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
 * Why `command` needs a human's approval, or `null`. Not a refusal: the caller
 * checks `checkCommand` first — a hardline command is refused whatever this
 * says. See APPROVAL_PATTERNS for who acts on it.
 */
export function approvalRequiredReason(command: string): string | null {
  for (const { test, reason } of APPROVAL_PATTERNS) {
    if (test(command)) return reason;
  }
  return null;
}

export interface GuardHookOptions {
  /**
   * True when the loop this hook guards also carries a host approval gate — a
   * `before_tool_call` hook built on the danger predicate that asks a human or
   * refuses. The guard then leaves approval-required commands to that gate.
   * Absent or false → the guard refuses them itself (no one could approve).
   * Read per call. Hardline commands are refused either way.
   */
  approvalGated?: () => boolean;
}

function approvalRefusal(reason: string): string {
  return (
    `Command blocked: ${reason} requires explicit human approval, and this surface cannot ask for it. ` +
    'Rewrite the command without it, or run it from a surface with approval prompts ' +
    '(the web UI, or a chat platform with approval cards).'
  );
}

/**
 * The hard-blocking `before_tool_call` guard for `process_start`. An
 * approval-required command (`approvalRequiredReason`) is refused too unless
 * `opts.approvalGated` says a host approval gate covers this loop.
 */
export function createProcessGuardHook(
  opts: GuardHookOptions = {},
): (payload: BeforeToolCallPayload) => Promise<Partial<BeforeToolCallResult> | null> {
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
    const approval = approvalRequiredReason(args.command);
    if (approval && opts.approvalGated?.() !== true) return { error: approvalRefusal(approval) };
    return null;
  };
}
