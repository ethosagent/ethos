// `ethos skills history | diff | restore | lock | unlock` — the CLI face of
// `SkillHistory` (extensions/skills/src/skill-history.ts) for the flat markdown
// skills (`<dataDir>/skills/<id>.md`, `<dataDir>/personalities/<pid>/skills/<id>.md`).
//
// Everything goes through the injected `Storage` (the command passes `getStorage()`),
// never raw `node:fs`; `apps/ethos/src/__tests__/no-raw-fs.test.ts` pins that. The
// lock is enforced by `SkillHistory.writeAgentAuthored`, not here: `lock` and
// `unlock` only flip the sidecar, and `restore` is a human write that the lock
// does not block.

import { join } from 'node:path';
import {
  assertSafeId,
  BoundaryError,
  EthosError,
  IdValidationError,
  type Storage,
} from '@ethosagent/types';
import {
  diffSkillVersions,
  SkillHistory,
  type SkillVersion,
} from '@ethosagent/wiring/skill-history';
import { splitJson, writeJson, writeJsonError } from '../json-output';

const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  red: '\x1b[31m',
};

export const SKILLS_HISTORY_VERBS: readonly string[] = [
  'history',
  'diff',
  'restore',
  'lock',
  'unlock',
];

export const SKILLS_HISTORY_USAGE = [
  '  history <id> [--personality <pid>] [--json]   every version, oldest first, with who wrote it',
  '  diff <id> <a> [<b>] [--personality <pid>]     a line diff; b defaults to the live file',
  '  restore <id> <versionId> [--personality <pid>] make an older version live, as a new version',
  '  lock <id> [--personality <pid>]               refuse every agent-authored write to it',
  '  unlock <id> [--personality <pid>]             allow agent-authored writes again',
];

export interface SkillsHistoryIo {
  out(line: string): void;
  err(line: string): void;
}

export interface SkillsHistoryDeps {
  storage: Storage;
  /** `~/.ethos` (or `ETHOS_STATE_DIR`). */
  dataDir: string;
  io: SkillsHistoryIo;
}

class CliRefusal extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'INVALID_INPUT',
    message: string,
  ) {
    super(message);
  }
}

/** Runs one verb. Returns the exit code. */
export async function runSkillsHistoryCommand(
  argv: string[],
  deps: SkillsHistoryDeps,
): Promise<number> {
  const { json, args } = splitJson(argv);
  const verb = args[0] ?? '';
  const personalityId = flagValue(args, '--personality');
  const words = positionals(args.slice(1));
  const id = words[0];
  if (!id) return fail(deps, json, 'INVALID_INPUT', `Usage: ethos skills ${verb} <id> …`);

  try {
    const history = new SkillHistory({ storage: deps.storage, dataDir: deps.dataDir });
    const dest = destinationOf(deps.dataDir, id, personalityId);
    switch (verb) {
      case 'history':
        return await showHistory(deps, history, dest, id, personalityId, json);
      case 'diff':
        return await showDiff(deps, history, dest, id, words[1], words[2], json);
      case 'restore':
        return await restore(deps, history, dest, id, words[1], json);
      case 'lock':
      case 'unlock':
        return await setLock(deps, history, dest, id, personalityId, verb === 'lock', json);
      default:
        return fail(deps, json, 'INVALID_INPUT', `Unknown skills verb: ${verb}`);
    }
  } catch (err) {
    if (err instanceof CliRefusal) return fail(deps, json, err.code, err.message);
    if (err instanceof IdValidationError) {
      return fail(deps, json, 'INVALID_INPUT', `Invalid ${err.kind}: "${err.id}"`);
    }
    if (err instanceof BoundaryError) {
      return fail(deps, json, 'INVALID_INPUT', `Invalid skill id: "${id}"`);
    }
    if (err instanceof EthosError) return fail(deps, json, 'NOT_FOUND', err.cause);
    throw err;
  }
}

async function showHistory(
  deps: SkillsHistoryDeps,
  history: SkillHistory,
  dest: string,
  id: string,
  personalityId: string | undefined,
  json: boolean,
): Promise<number> {
  const versions = await history.versions(dest);
  if (versions.length === 0 && !(await deps.storage.exists(dest))) {
    throw new CliRefusal('NOT_FOUND', notFoundText(id, personalityId));
  }
  const locked = await history.isLocked(dest);
  if (json) {
    writeJson({ ok: true, id, personalityId: personalityId ?? null, locked, versions });
    return 0;
  }
  deps.io.out(`${c.bold}${id}${c.reset}${locked ? `  ${c.dim}(locked)${c.reset}` : ''}`);
  for (const v of versions) deps.io.out(`  ${versionLine(v)}`);
  return 0;
}

async function showDiff(
  deps: SkillsHistoryDeps,
  history: SkillHistory,
  dest: string,
  id: string,
  a: string | undefined,
  b: string | undefined,
  json: boolean,
): Promise<number> {
  if (!a) throw new CliRefusal('INVALID_INPUT', 'Usage: ethos skills diff <id> <a> [<b>]');
  const versions = await history.versions(dest);
  const from = pick(versions, a);
  const to = b === undefined ? null : pick(versions, b);
  const before = await history.readVersion(dest, from.versionId);
  const after = to ? await history.readVersion(dest, to.versionId) : await deps.storage.read(dest);
  const diff = diffSkillVersions(before, after);
  if (json) {
    writeJson({ ok: true, id, from: from.versionId, to: to?.versionId ?? 'live', diff });
    return 0;
  }
  deps.io.out(`${c.dim}--- ${from.versionId}${c.reset}`);
  deps.io.out(`${c.dim}+++ ${to?.versionId ?? 'live'}${c.reset}`);
  for (const line of diff.split('\n')) deps.io.out(line);
  return 0;
}

async function restore(
  deps: SkillsHistoryDeps,
  history: SkillHistory,
  dest: string,
  id: string,
  versionToken: string | undefined,
  json: boolean,
): Promise<number> {
  if (!versionToken) {
    throw new CliRefusal('INVALID_INPUT', 'Usage: ethos skills restore <id> <versionId>');
  }
  const target = pick(await history.versions(dest), versionToken);
  const { versionId } = await history.restore(dest, target.versionId, 'cli');
  if (json) {
    writeJson({ ok: true, id, restoredFrom: target.versionId, versionId });
    return 0;
  }
  deps.io.out(
    `${c.green}restored${c.reset} ${id} to ${target.versionId} ${c.dim}(new version ${versionId})${c.reset}`,
  );
  return 0;
}

async function setLock(
  deps: SkillsHistoryDeps,
  history: SkillHistory,
  dest: string,
  id: string,
  personalityId: string | undefined,
  locked: boolean,
  json: boolean,
): Promise<number> {
  if (!(await deps.storage.exists(dest))) {
    throw new CliRefusal('NOT_FOUND', notFoundText(id, personalityId));
  }
  await history.setLock(dest, locked, 'cli');
  if (json) {
    writeJson({ ok: true, id, locked });
    return 0;
  }
  deps.io.out(
    locked
      ? `${c.green}locked${c.reset} ${id} ${c.dim}— agents can no longer change it; you still can${c.reset}`
      : `${c.green}unlocked${c.reset} ${id}`,
  );
  return 0;
}

// --- helpers -----------------------------------------------------------------

function destinationOf(dataDir: string, id: string, personalityId: string | undefined): string {
  assertSafeId(id, 'skillId');
  if (personalityId === undefined) return join(dataDir, 'skills', `${id}.md`);
  assertSafeId(personalityId, 'personalityId');
  return join(dataDir, 'personalities', personalityId, 'skills', `${id}.md`);
}

/** An exact version id, or a prefix that names exactly one. */
function pick(versions: SkillVersion[], token: string): SkillVersion {
  const exact = versions.find((v) => v.versionId === token);
  if (exact) return exact;
  const byPrefix = versions.filter((v) => v.versionId.startsWith(token));
  if (byPrefix.length === 1 && byPrefix[0]) return byPrefix[0];
  throw new CliRefusal(
    'NOT_FOUND',
    byPrefix.length > 1
      ? `Version "${token}" is ambiguous; use more of its id.`
      : `No version "${token}". List them with: ethos skills history <id>`,
  );
}

function versionLine(v: SkillVersion): string {
  const bytes = v.hash === null ? 'deleted' : v.hash.slice(0, 8);
  const extra = v.restoredFrom
    ? ` ← ${v.restoredFrom}`
    : v.candidateId
      ? ` ${v.candidateId}`
      : v.note
        ? ` ${v.note}`
        : '';
  return `${v.versionId}  ${v.source.padEnd(17)} ${v.actor.padEnd(10)} ${c.dim}${bytes}${extra}${c.reset}`;
}

function notFoundText(id: string, personalityId: string | undefined): string {
  return `No skill "${id}"${personalityId ? ` for personality "${personalityId}"` : ''}.`;
}

function fail(
  deps: SkillsHistoryDeps,
  json: boolean,
  code: 'NOT_FOUND' | 'INVALID_INPUT',
  message: string,
): number {
  if (json) writeJsonError(code, message);
  deps.io.err(`${c.red}${message}${c.reset}`);
  return 1;
}

function flagValue(args: readonly string[], flag: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    if (arg === flag) return args[i + 1];
    if (arg.startsWith(`${flag}=`)) return arg.slice(flag.length + 1);
  }
  return undefined;
}

/** Positional words: everything that is not `--personality` or its value. */
function positionals(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    if (arg === '--personality') i++;
    else if (!arg.startsWith('--')) out.push(arg);
  }
  return out;
}
