// `ethos personality amendments` — the owner's side of governed self-amendment
// (plan personality-memory-boundary-and-self-amendment G2, D30–D32). The v1
// apply surface: the web view is read-only. A request changes `toolset.yaml`
// (target `toolset`) or the identity lines of `config.yaml` (target `identity`,
// the birth ritual's filing — plan personality-presence-and-initiative §1);
// every message names the file `AmendmentReview.file` says.
//
//   ethos personality amendments list [--personality <id>] [--all] [--json]
//   ethos personality amendments show <id> [--json]
//   ethos personality amendments apply <id>
//   ethos personality amendments decline <id> --reason "<text>"
//   ethos personality amendments rollback <id>
//
// Every read and decision goes through `AmendmentService`
// (packages/wiring/src/amendments.ts), handed to this command as
// `CreateAgentLoopResult.amendments`. The lock, the live recompute, the
// constitution, the compare-and-swap and the approval rows are the service's;
// this file parses arguments, prints, and holds the D32 gate:
//
// - `apply` and `rollback` refuse under `ETHOS_TOOL_PROCESS=1`
//   (`assertNotToolProcess`) — a TRIPWIRE, not a boundary: `env -u` defeats it,
//   and a personality holding a shell tool under local execution can already
//   edit its own definition (G2-1's exception);
// - they refuse without a TTY on stdin and stdout (`assertTty`) — a pty
//   wrapper defeats it;
// - they need the personality id typed back (`confirmTyped`);
// - `apply` passes the `expectedAfterHash` of the review it printed, so the
//   service writes exactly the bytes the owner read or refuses (G2-5).
//
// Pinned by apps/ethos/src/commands/__tests__/personality-amendments.test.ts.

import { userInfo } from 'node:os';
import { createInterface } from 'node:readline';
import {
  type AmendmentOp,
  type AmendmentRecord,
  type AmendmentStatus,
  EthosError,
  type EthosErrorCode,
  TOOL_PROCESS_ENV_VAR,
} from '@ethosagent/types';
import type {
  AmendmentActionCode,
  AmendmentActionResult,
  AmendmentReview,
  AmendmentService,
} from '@ethosagent/wiring';

const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
};

export interface AmendmentsCliDeps {
  service: AmendmentService;
  /** One line; a newline is added. */
  out(line: string): void;
  /** Both stdin and stdout are terminals. */
  isTty: boolean;
  /** The process environment — only `ETHOS_TOOL_PROCESS` is read. */
  env: Readonly<Record<string, string | undefined>>;
  /** Ask one question on the terminal and return the line typed. */
  ask(question: string): Promise<string>;
  /** The audit label for a decision, never a gate. */
  decidedBy: string;
}

const USAGE = [
  'Usage: ethos personality amendments <command>',
  '',
  '  list [--personality <id>] [--all] [--json]   requests waiting for you (--all: every status)',
  '  show <id> [--json]                           permission diff, file diff, flags, history',
  '  apply <id>                                   apply it (terminal only; type the personality id)',
  '  decline <id> --reason "<text>"               decline it (also closes a stale one)',
  '  rollback <id>                                restore the file it replaced',
];

/** Flags that take a value, so the value is never mistaken for the positional id. */
const VALUE_FLAGS = new Set(['--personality', '--reason']);

/** What `list` shows by default: the requests the owner still has to close. */
const OPEN: readonly AmendmentStatus[] = ['pending', 'stale'];

/** Build the loop, hand its `amendments` service to the command, release the loop. */
export async function runPersonalityAmendments(args: string[]): Promise<void> {
  // The gate runs before the (heavy) loop is built, and again in the body.
  const sub = args[0];
  if (sub === 'apply' || sub === 'rollback') {
    assertNotToolProcess(process.env);
    assertTty(Boolean(process.stdin.isTTY && process.stdout.isTTY));
  }
  const { loadRequiredConfig } = await import('../managed-mode');
  const { createAgentLoop } = await import('../wiring');
  const { releaseCommandRuntime } = await import('../lib/release-command-runtime');
  const config = await loadRequiredConfig();
  const runtime = await createAgentLoop(config);
  try {
    await runPersonalityAmendmentsCommand(args, {
      service: runtime.amendments,
      out: (line) => console.log(line),
      isTty: Boolean(process.stdin.isTTY && process.stdout.isTTY),
      env: process.env,
      ask: askLine,
      decidedBy: operatorLabel(),
    });
  } finally {
    await releaseCommandRuntime(runtime, { label: 'amendments agent loop', drainMs: 0 });
  }
}

/** The command body, with every dependency injected. Throws `EthosError` on any failure. */
export async function runPersonalityAmendmentsCommand(
  args: readonly string[],
  deps: AmendmentsCliDeps,
): Promise<void> {
  const [sub, ...rest] = args;
  switch (sub) {
    case 'list':
      return list(rest, deps);
    case 'show':
      return show(requireId(rest), rest.includes('--json'), deps);
    case 'apply':
      return apply(requireId(rest), deps);
    case 'decline':
      return decline(requireId(rest), flagValue(rest, '--reason'), deps);
    case 'rollback':
      return rollback(requireId(rest), deps);
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      for (const line of USAGE) deps.out(line);
      return;
    default:
      throw new EthosError({
        code: 'INVALID_INPUT',
        cause: `Unknown subcommand: ${sub}`,
        action: 'Run `ethos personality amendments help` for the commands.',
      });
  }
}

// --- The D32 gate ------------------------------------------------------------

/**
 * Refuse when this process was spawned by an agent's shell tool. A tripwire,
 * not a boundary — see `TOOL_PROCESS_ENV_VAR` (packages/types/src/amendment.ts).
 */
export function assertNotToolProcess(env: Readonly<Record<string, string | undefined>>): void {
  if (env[TOOL_PROCESS_ENV_VAR] !== '1') return;
  throw new EthosError({
    code: 'FORBIDDEN',
    cause: `${TOOL_PROCESS_ENV_VAR}=1: this looks like a process an agent's tool started, and an agent does not apply or roll back its own amendments`,
    action:
      'Run this from your own terminal. (This check is a tripwire, not a boundary: it catches the plain case only.)',
  });
}

export function assertTty(isTty: boolean): void {
  if (isTty) return;
  throw new EthosError({
    code: 'FORBIDDEN',
    cause: 'apply and rollback need an interactive terminal (stdin and stdout are not a TTY)',
    action: 'Run the command yourself in a terminal; it asks you to type the personality id.',
  });
}

async function confirmTyped(personalityId: string, verb: string, deps: AmendmentsCliDeps) {
  const answer = await deps.ask(
    `Type the personality id (${cleanLine(personalityId)}) to ${verb}: `,
  );
  if (answer.trim() === personalityId) return;
  throw new EthosError({
    code: 'FORBIDDEN',
    cause: `Confirmation did not match "${cleanLine(personalityId)}"; nothing was ${verb === 'apply' ? 'applied' : 'rolled back'}`,
    action: 'Re-run the command and type the personality id exactly.',
  });
}

// --- Subcommands -------------------------------------------------------------

async function list(args: readonly string[], deps: AmendmentsCliDeps): Promise<void> {
  const personalityId = flagValue(args, '--personality');
  const all = args.includes('--all');
  const records = await deps.service.list({
    ...(personalityId ? { personalityId } : {}),
    ...(all ? {} : { status: OPEN }),
  });
  if (args.includes('--json')) {
    deps.out(JSON.stringify(records, null, 2));
    return;
  }
  if (records.length === 0) {
    deps.out(
      `${c.dim}${all ? 'No amendments.' : 'No amendments waiting for a decision.'}${c.reset}`,
    );
    return;
  }
  for (const line of table(
    ['ID', 'PERSONALITY', 'CHANGE', 'STATUS', 'FILED'],
    records.map((r) =>
      [r.id, r.personalityId, opsLabel(r), r.status, r.createdAt.slice(0, 16)].map(cleanLine),
    ),
  )) {
    deps.out(line);
  }
  deps.out('');
  deps.out(`${c.dim}Review one with: ethos personality amendments show <id>${c.reset}`);
}

async function show(id: string, json: boolean, deps: AmendmentsCliDeps): Promise<void> {
  const review = await getReview(id, deps);
  if (json) {
    deps.out(JSON.stringify(review, null, 2));
    return;
  }
  printReview(review, deps);
  const next = nextStep(review);
  if (next) deps.out(`${c.dim}${next}${c.reset}`);
}

async function apply(id: string, deps: AmendmentsCliDeps): Promise<void> {
  assertNotToolProcess(deps.env);
  assertTty(deps.isTty);
  const review = await getReview(id, deps);
  const { record } = review;
  const by = { actor: 'cli' as const, decidedBy: deps.decidedBy };
  if (review.interruptedApply) {
    // An earlier apply wrote these bytes and died before recording it: record
    // it now (`AmendmentService.refresh`). Nothing new is written.
    const done = settled(id, await deps.service.refresh(id, by));
    deps.out(
      `${c.green}✓${c.reset} Recorded ${cleanLine(id)} as applied: an earlier apply had already written ${cleanLine(done.personalityId)}'s ${review.file}.`,
    );
    deps.out(`${c.dim}Undo with: ethos personality amendments rollback ${id}${c.reset}`);
    return;
  }
  if (record.status !== 'pending') {
    throw new EthosError({
      code: 'CONFIG_CONFLICT',
      cause: `Amendment ${cleanLine(id)} is ${cleanLine(record.status)}, not pending`,
      action: nextStep(review) ?? 'Nothing to apply.',
    });
  }
  const expected = review.expectedAfterHash;
  if (review.stale || expected === null) {
    // Record what the review found, so a request that can no longer apply is
    // `stale` and stops counting toward the pending limit.
    const refreshed = await deps.service.refresh(id, by);
    throw new EthosError({
      code: 'CONFIG_CONFLICT',
      cause: review.stale
        ? `Amendment ${cleanLine(id)} is stale: ${cleanLine(record.personalityId)}'s ${review.file} changed since it was filed`
        : `Amendment ${cleanLine(id)} no longer applies: ${cleanLine(review.opsProblem ?? 'nothing to change')}`,
      action: `Close it with: ethos personality amendments decline ${id} --reason "<text>"`,
      details: { status: refreshed.ok ? refreshed.record.status : refreshed.record?.status },
    });
  }
  printReview(review, deps);
  await confirmTyped(record.personalityId, 'apply', deps);
  // The hash of the review just printed — the service writes exactly these
  // bytes, onto exactly the bytes it was filed against, or refuses (G2-5).
  const result = await deps.service.apply(id, { ...by, expectedAfterHash: expected });
  // The file moved after the review: record whether the request still applies.
  if (!result.ok && result.code === 'hash_mismatch') await deps.service.refresh(id, by);
  const done = settled(id, result);
  deps.out(
    `${c.green}✓${c.reset} Applied ${cleanLine(id)} to ${cleanLine(done.personalityId)}'s ${review.file}. Other processes pick it up on their next turn.`,
  );
  if (done.ops.some((o) => o.op === 'set_display_avatar' && o.value === 'upload')) {
    // The personality never supplies an image: `upload` leaves config.yaml
    // alone and the owner uploads one (only `writeAvatar` sets avatar_url).
    deps.out(
      `  Upload the avatar from the web Personalities page for ${cleanLine(done.personalityId)}; until then it shows the generated mark.`,
    );
  }
  deps.out(`${c.dim}Undo with: ethos personality amendments rollback ${id}${c.reset}`);
}

async function decline(
  id: string,
  reason: string | undefined,
  deps: AmendmentsCliDeps,
): Promise<void> {
  if (!reason?.trim()) {
    throw new EthosError({
      code: 'INVALID_INPUT',
      cause: 'Declining needs a reason',
      action: `ethos personality amendments decline ${id} --reason "<text>"`,
    });
  }
  const result = await deps.service.decline(id, {
    actor: 'cli',
    decidedBy: deps.decidedBy,
    reason: reason.trim(),
  });
  settled(id, result);
  deps.out(`${c.green}✓${c.reset} Declined ${id}.`);
}

async function rollback(id: string, deps: AmendmentsCliDeps): Promise<void> {
  assertNotToolProcess(deps.env);
  assertTty(deps.isTty);
  const review = await getReview(id, deps);
  const { record } = review;
  if (record.status !== 'applied') {
    throw new EthosError({
      code: 'CONFIG_CONFLICT',
      cause: `Amendment ${cleanLine(id)} is ${cleanLine(record.status)}; only an applied amendment rolls back`,
      action: 'List what was applied with: ethos personality amendments list --all',
    });
  }
  deps.out(
    `${c.bold}Roll back ${cleanLine(record.id)}${c.reset} — ${cleanLine(record.personalityId)}`,
  );
  deps.out(`  Undoes: ${opsLabel(record)}`);
  deps.out(
    `  Restores the ${review.file} saved when it was applied (${cleanLine(record.applied?.at ?? '?')}).`,
  );
  deps.out(`  Refused if ${review.file} was edited since, or the constitution forbids the result.`);
  deps.out('');
  deps.out(`  ${c.bold}${review.file}${c.reset} (live → restored)`);
  if (review.rollbackDiff.length === 0) {
    deps.out(`    ${c.dim}(no saved snapshot — rollback will refuse)${c.reset}`);
  }
  for (const line of review.rollbackDiff)
    deps.out(`    ${diffColour(line)}${cleanLine(line)}${c.reset}`);
  deps.out('');
  await confirmTyped(record.personalityId, 'roll back', deps);
  const result = await deps.service.rollback(id, { actor: 'cli', decidedBy: deps.decidedBy });
  const done = settled(id, result);
  deps.out(
    `${c.green}✓${c.reset} Rolled back ${cleanLine(id)}; ${cleanLine(done.personalityId)}'s ${review.file} is restored.`,
  );
}

// --- Printing ----------------------------------------------------------------

function printReview(review: AmendmentReview, deps: AmendmentsCliDeps): void {
  const { record } = review;
  const out = deps.out;
  out(`${c.bold}Amendment ${cleanLine(record.id)}${c.reset}  [${cleanLine(record.status)}]`);
  out(`  Personality: ${cleanLine(record.personalityId)}${personalityNote(review)}`);
  out(`  Change:      ${opsLabel(record)}`);
  if (review.flags.includes('local-terminal')) {
    out('');
    out(
      `  ${c.yellow}${c.bold}! this personality can already edit its own definition — this review is not a boundary for it.${c.reset}`,
    );
    out(
      `  ${c.dim}  It holds a shell tool under local execution, so it can change ${review.file} or run this command itself.${c.reset}`,
    );
  }
  if (review.stale) {
    out(
      `  ${c.yellow}Stale: ${review.file} changed since this was filed — apply will refuse.${c.reset}`,
    );
  }
  if (review.interruptedApply) {
    out(
      `  ${c.yellow}An earlier apply was interrupted after it wrote ${review.file}. Run apply to record it.${c.reset}`,
    );
  }
  if (review.opsProblem)
    out(`  ${c.yellow}No longer applies: ${cleanLine(review.opsProblem)}${c.reset}`);
  out('');
  if (record.target === 'toolset') {
    out(`  ${c.bold}Permission diff${c.reset}`);
    const changes = review.permissionDiff?.changes ?? [];
    if (changes.length === 0) out(`    ${c.dim}(no permission row changes)${c.reset}`);
    for (const change of changes) {
      const colour =
        change.direction === 'widens' ? c.red : change.direction === 'narrows' ? c.green : c.yellow;
      const flag = change.flag ? `  ${c.bold}[${change.flag}]${c.reset}` : '';
      out(
        `    ${colour}${change.direction.toUpperCase().padEnd(7)}${c.reset} ${cleanLine(change.section)}: ${cleanLine(change.detail)}${flag}`,
      );
    }
    out(`    ${c.dim}${cleanLine(review.notCompared)}${c.reset}`);
  } else {
    // An identity change sets how the personality presents itself; it grants
    // no tool, reach or permission (`applyTargetOps`, packages/wiring).
    out(
      `  ${c.bold}Permission diff${c.reset}  ${c.dim}none — an identity change grants nothing${c.reset}`,
    );
  }
  out('');
  out(`  ${c.bold}${review.file}${c.reset}`);
  if (review.textDiff.length === 0) out(`    ${c.dim}(no diff — see above)${c.reset}`);
  for (const line of review.textDiff) out(`    ${diffColour(line)}${cleanLine(line)}${c.reset}`);
  out('');
  out(
    `  ${c.bold}Flags${c.reset}        ${review.flags.length > 0 ? cleanLine(review.flags.join(', ')) : 'none'}`,
  );
  out(
    `  ${c.bold}Rationale${c.reset}    ${c.dim}(written by the personality — untrusted)${c.reset}`,
  );
  for (const line of clean(record.rationale).split('\n')) out(`    ${line}`);
  out(`  ${c.bold}Evidence${c.reset}`);
  if (record.evidence.length === 0) out(`    ${c.dim}none cited${c.reset}`);
  for (const e of record.evidence) {
    out(
      `    ${cleanLine(e.toolName)} refused (call ${cleanLine(e.toolCallId)}): ${cleanLine(e.excerpt)}`,
    );
  }
  const p = record.provenance;
  out(
    `  ${c.bold}Filed${c.reset}        ${cleanLine(record.createdAt)} from ${cleanLine(p.sessionKey)}`,
  );
  const origin = `platform ${p.platform} · initiator ${p.initiator} · room ${p.roomAudience} · execution ${p.executionPosture}`;
  out(
    `    ${c.dim}${cleanLine(origin)}${p.holdsShellTool ? ' · holds a shell tool' : ''}${c.reset}`,
  );
  out(`  ${c.bold}History${c.reset}`);
  for (const h of record.history) {
    const by = h.decidedBy ? ` by ${h.decidedBy}` : '';
    const why = h.reason ? ` — ${h.reason}` : '';
    out(`    ${cleanLine(`${h.at}  ${h.action} (${h.actor}${by})${why}`)}`);
  }
  if (review.expectedAfterHash) {
    out(`  ${c.bold}Review hash${c.reset}  ${cleanLine(review.expectedAfterHash)}`);
  }
  out('');
}

function personalityNote(review: AmendmentReview): string {
  if (review.personality === 'not_found') return ` ${c.yellow}(no longer exists)${c.reset}`;
  if (review.personality === 'builtin')
    return ` ${c.yellow}(built-in — cannot be changed)${c.reset}`;
  return '';
}

function nextStep(review: AmendmentReview): string | null {
  const id = cleanLine(review.record.id);
  if (review.interruptedApply) {
    return `Record the interrupted apply with: ethos personality amendments apply ${id}`;
  }
  switch (review.record.status) {
    case 'pending':
      return review.stale || review.expectedAfterHash === null
        ? `Close it with: ethos personality amendments decline ${id} --reason "<text>"`
        : `Apply it with: ethos personality amendments apply ${id}  (or decline ${id} --reason "<text>")`;
    case 'stale':
      return `Close it with: ethos personality amendments decline ${id} --reason "<text>"`;
    case 'applied':
      return `Undo it with: ethos personality amendments rollback ${id}`;
    default:
      return null;
  }
}

/** `+ terminal, - web_fetch`, or `name → "Ledger", emoji → 🧾, avatar → generated mark`. */
function opsLabel(record: Pick<AmendmentRecord, 'ops'>): string {
  return cleanLine(record.ops.map(opLabel).join(', '));
}

function opLabel(o: AmendmentOp): string {
  switch (o.op) {
    case 'add_tool':
      return `+ ${o.tool}`;
    case 'remove_tool':
      return `- ${o.tool}`;
    case 'set_name':
      return `name → "${o.value}"`;
    case 'set_description':
      return `vibe → "${o.value}"`;
    case 'set_display_emoji':
      return `emoji → ${o.value}`;
    case 'set_display_avatar':
      return o.value === 'upload' ? 'avatar → upload after applying' : 'avatar → generated mark';
  }
}

function diffColour(line: string): string {
  return line.startsWith('+') ? c.green : line.startsWith('-') ? c.red : c.dim;
}

/**
 * Every string read from an amendment record is printed through this —
 * the rationale and evidence excerpts, and equally the tool names, call ids,
 * session key, platform, history actors and ids a tampered or model-shaped
 * record can carry (verification round F4). Personality-written text is
 * untrusted: replace terminal control sequences
 * (C0 except newline and tab, DEL, C1) so it cannot recolour, move the cursor
 * or overwrite the lines around it, and the invisible characters that make
 * text read other than it is — bidi embeddings and overrides (U+202A–U+202E),
 * bidi isolates (U+2066–U+2069), and zero-width and direction marks
 * (U+200B–U+200F, U+2060, U+FEFF).
 */
export function clean(text: string): string {
  return text.replace(
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
    /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/g,
    '?',
  );
}

/**
 * {@link clean} for a field that is one line by definition — ids, tool names,
 * call ids, the session key, platform, history actors, reasons, excerpts —
 * with newlines and tabs replaced too, so a newline planted in one cannot
 * print a line that looks like the command's own (verification round G8).
 * Every string read from a record is printed through this except the
 * rationale, which is multi-line and printed under its "untrusted" label.
 */
export function cleanLine(text: string): string {
  return clean(text).replace(/[\n\t]/g, '?');
}

function table(header: string[], rows: string[][]): string[] {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (cells: string[]) =>
    cells
      .map((cell, i) => cell.padEnd(widths[i] ?? 0))
      .join('  ')
      .trimEnd();
  return [line(header), ...rows.map(line)];
}

// --- Results -----------------------------------------------------------------

async function getReview(id: string, deps: AmendmentsCliDeps): Promise<AmendmentReview> {
  const review = await deps.service.get(id);
  if (review) return review;
  throw new EthosError({
    code: 'NOT_FOUND',
    cause: `No amendment ${id}`,
    action: 'List them with: ethos personality amendments list --all',
  });
}

const ACTION_ERROR_CODES: Record<AmendmentActionCode, EthosErrorCode> = {
  not_found: 'NOT_FOUND',
  not_pending: 'CONFIG_CONFLICT',
  not_applied: 'CONFIG_CONFLICT',
  personality_not_found: 'PERSONALITY_NOT_FOUND',
  builtin: 'PERSONALITY_READ_ONLY',
  stale: 'CONFIG_CONFLICT',
  hash_mismatch: 'CONFIG_CONFLICT',
  auto_rejected: 'FORBIDDEN',
  constitution_violation: 'FORBIDDEN',
  constitution_malformed: 'CONFIG_INVALID',
  live_edited: 'CONFIG_CONFLICT',
  prior_missing: 'FILE_NOT_FOUND',
  record_mismatch: 'CONFIG_CONFLICT',
  reason_required: 'INVALID_INPUT',
  locked: 'CONFIG_CONFLICT',
};

const ACTION_HINTS: Partial<Record<AmendmentActionCode, string>> = {
  stale: 'The definition changed under it. Close it with decline; the personality can file again.',
  hash_mismatch:
    'The definition file changed after the review was printed. Run show again, then apply.',
  auto_rejected: 'The constitution forbids the result. Nothing was written.',
  constitution_violation:
    'The constitution forbids the result, or the current definition already. Nothing was written.',
  constitution_malformed: 'Fix ~/.ethos/constitution.yaml, then retry.',
  live_edited:
    'The definition file was edited after the apply; roll back later amendments first, or edit it by hand.',
  locked: 'Another amendment operation is running. Retry in a moment.',
  record_mismatch:
    'The stored amendment or its snapshot was edited on disk. Restore the definition file by hand.',
};

/** The record an action settled on, or the `EthosError` for its refusal. */
function settled(id: string, result: AmendmentActionResult): AmendmentRecord {
  if (result.ok) return result.record;
  throw new EthosError({
    code: ACTION_ERROR_CODES[result.code],
    cause: `${id}: ${cleanLine(result.reason)}`,
    action:
      ACTION_HINTS[result.code] ?? 'Run `ethos personality amendments show <id>` for its state.',
    details: { amendmentCode: result.code, status: result.record?.status },
  });
}

// --- Arguments ---------------------------------------------------------------

function requireId(args: readonly string[]): string {
  const id = positional(args);
  if (id) return id;
  throw new EthosError({
    code: 'INVALID_INPUT',
    cause: 'An amendment id is required',
    action: 'List them with: ethos personality amendments list',
  });
}

/** `--flag value` or `--flag=value`. */
function flagValue(args: readonly string[], flag: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    if (arg === flag) return args[i + 1];
    if (arg.startsWith(`${flag}=`)) return arg.slice(flag.length + 1);
  }
  return undefined;
}

function positional(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    if (VALUE_FLAGS.has(arg)) {
      i++;
      continue;
    }
    if (!arg.startsWith('-')) return arg;
  }
  return undefined;
}

// --- Terminal ----------------------------------------------------------------

function askLine(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

function operatorLabel(): string {
  try {
    return `cli:${userInfo().username}`;
  } catch {
    return 'cli';
  }
}
