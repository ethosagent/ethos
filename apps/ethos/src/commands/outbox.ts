// `ethos outbox` — the terminal approval path for the personality approval
// outbox (plan `trust-before-reach.md` Part 2).
//
//   ethos outbox list [--personality <id>] [--all]
//   ethos outbox show <id>
//   ethos outbox approve <id> --revision <n>
//   ethos outbox reject <id> [--reason "<text>"]
//
// Every decision goes through `OutboxService` (`extensions/outbox/src/
// service.ts`), the class web-api's outbox service and the Telegram card glue
// (`createOutboxApprovalSurface`, `../lib/outbox-wiring.ts`) decide through.
// The bound approve (revision + content hash in one conditional UPDATE), the
// `outbox.*` audit rows (X-D11) and the "changed since you viewed it" answer
// are the service's; this file only parses arguments and prints.
//
// It never sends. Approving writes one row; the dispatcher in the gateway
// process that holds the sending bot (`createOutboxDispatcher`) delivers it.

import { userInfo } from 'node:os';
import { join } from 'node:path';
import { ethosDir } from '@ethosagent/config';
import {
  type OutboxItem,
  OutboxService,
  type OutboxState,
  SQLiteOutboxStore,
} from '@ethosagent/outbox';
import { getEthosObservability, getStorage } from '../wiring';

const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  red: '\x1b[31m',
};

export interface OutboxCliIo {
  /** One line; a newline is added. */
  out(line: string): void;
  err(line: string): void;
  /** Raw bytes, nothing added — how `show` prints the draft. */
  write(raw: string): void;
}

const CONSOLE_IO: OutboxCliIo = {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
  write: (raw) => {
    process.stdout.write(raw);
  },
};

const USAGE = [
  'Usage: ethos outbox <command>',
  '',
  '  list [--personality <id>] [--all]      publications waiting for a human (--all: every state)',
  '  show <id>                              destination, sender, reviewer receipt, and the exact text',
  '  approve <id> --revision <n>            approve the revision you read with `show`',
  '  reject <id> [--reason "<text>"]        refuse it; the agent can propose again',
  '',
  'Approving never sends from this command. The gateway holding the sending bot',
  'publishes the approved revision on its next poll.',
];

/** Flags that take a value, so the value is never mistaken for the positional id. */
const VALUE_FLAGS = new Set(['--personality', '--reason', '--revision']);

const WAITING: readonly OutboxState[] = ['awaiting_review', 'awaiting_approval'];
const ALL_STATES: readonly OutboxState[] = [
  'awaiting_review',
  'awaiting_approval',
  'approved',
  'sending',
  'sent',
  'unconfirmed',
  'failed',
  'rejected',
  'expired',
];

/** The draft is printed between these two lines, byte for byte. */
export const DRAFT_BEGIN = '-----BEGIN DRAFT-----';
export const DRAFT_END = '-----END DRAFT-----';

export async function runOutbox(args: string[]): Promise<void> {
  const path = join(ethosDir(), 'outbox.db');
  // Open only a file that exists: a machine that has never queued a
  // publication has no outbox, and reading it must not create one.
  const service = (await getStorage().exists(path))
    ? new OutboxService({
        store: new SQLiteOutboxStore(path),
        observability: {
          recordSafetyApproval: (o) => getEthosObservability().recordSafetyApproval(o),
        },
      })
    : null;
  try {
    const code = runOutboxCommand(args, service, CONSOLE_IO, operatorLabel());
    if (code !== 0) process.exitCode = code;
  } finally {
    service?.close();
  }
}

/**
 * The command body, with the service and output injected. Returns the exit
 * code. `service` is `null` when this machine has no `outbox.db`.
 * `decidedBy` is the audit label for a decision, never a gate.
 */
export function runOutboxCommand(
  args: readonly string[],
  service: OutboxService | null,
  io: OutboxCliIo = CONSOLE_IO,
  decidedBy = 'cli',
): number {
  const [sub, ...rest] = args;
  switch (sub) {
    case 'list':
      return list(rest, service, io);
    case 'show':
      return withId(rest, io, (id) => show(id, service, io));
    case 'approve':
      return withId(rest, io, (id) => approve(id, rest, service, io, decidedBy));
    case 'reject':
      return withId(rest, io, (id) => reject(id, rest, service, io, decidedBy));
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      for (const line of USAGE) io.out(line);
      return 0;
    default:
      io.err(`${c.red}Unknown subcommand: ${sub}${c.reset}`);
      for (const line of USAGE) io.err(line);
      return 1;
  }
}

// --- Subcommands -------------------------------------------------------------

function list(args: readonly string[], service: OutboxService | null, io: OutboxCliIo): number {
  const all = args.includes('--all');
  const states = all ? ALL_STATES : WAITING;
  const personalityId = flagValue(args, '--personality');
  const items = !service
    ? []
    : personalityId
      ? service.listByPersonality(personalityId).filter((i) => states.includes(i.state))
      : service.listByState(states);
  if (items.length === 0) {
    io.out(
      `${c.dim}${all ? 'The outbox is empty.' : 'Nothing is waiting for approval.'}${c.reset}`,
    );
    return 0;
  }
  for (const line of table(
    ['ID', 'PERSONALITY', 'DESTINATION', 'SENDER', 'STATE', 'REV', 'DRAFTED'],
    items.map((i) => [
      i.id,
      i.personalityId,
      destination(i),
      i.botKey,
      i.state,
      String(i.revision),
      new Date(i.createdAt).toISOString(),
    ]),
  )) {
    io.out(line);
  }
  return 0;
}

function show(id: string, service: OutboxService | null, io: OutboxCliIo): number {
  const item = service?.get(id);
  if (!service || !item) return notFound(id, io);
  const revision = service.getRevision(id, item.revision);
  if (!revision) {
    io.err(`${c.red}Revision ${item.revision} of ${id} is missing from the store.${c.reset}`);
    return 1;
  }

  io.out(`${c.bold}Outbox item ${item.id}${c.reset}`);
  io.out(`  personality:   ${item.personalityId}`);
  io.out(`  destination:   ${destination(item)}`);
  io.out(`  sender:        ${item.botKey}`);
  io.out(`  state:         ${item.state}`);
  io.out(
    `  revision:      ${item.revision}${revision.author === 'agent' ? '' : ` (edited by ${revision.author})`}`,
  );
  io.out(`  content hash:  ${item.contentHash}`);
  io.out(`  drafted:       ${new Date(item.createdAt).toISOString()}`);
  if (item.review) {
    const why = item.review.reasons ? ` — ${item.review.reasons}` : '';
    io.out(
      `  review:        ${item.approverPersonality ?? 'reviewer'}: ${item.review.verdict.toUpperCase()} (reviewed revision ${item.review.revision})${why}`,
    );
  }
  if (item.approvedBy) {
    io.out(
      `  approved by:   ${item.approvedBy} (revision ${item.approvedRevision ?? item.revision})`,
    );
  }
  if (item.rejectionReason) io.out(`  rejected:      ${item.rejectionReason}`);
  if (item.failureReason) io.out(`  failed:        ${item.failureReason}`);

  io.out('');
  io.out(
    `${c.bold}Text${c.reset} ${c.dim}revision ${revision.revision} · ${Buffer.byteLength(revision.text, 'utf8')} bytes · exactly what will be sent, between the markers${c.reset}`,
  );
  // The draft goes out through `write`, untouched: no trimming, no wrapping,
  // no colour. The newline after BEGIN and the one before END are the markers'
  // own, never part of the text.
  io.write(`${DRAFT_BEGIN}\n`);
  io.write(revision.text);
  io.write(`\n${DRAFT_END}\n`);

  if (item.state === 'awaiting_approval') {
    io.out('');
    io.out(`Approve: ethos outbox approve ${item.id} --revision ${item.revision}`);
    io.out(`Reject:  ethos outbox reject ${item.id} --reason "<why>"`);
  }
  return 0;
}

function approve(
  id: string,
  args: readonly string[],
  service: OutboxService | null,
  io: OutboxCliIo,
  decidedBy: string,
): number {
  const raw = flagValue(args, '--revision');
  if (raw === undefined) {
    io.err(
      `${c.red}approve needs --revision <n> — the revision you read with \`ethos outbox show ${id}\`.${c.reset}`,
    );
    io.err('An approval binds one exact text; approving "whatever is current" would not.');
    return 1;
  }
  const revision = Number(raw);
  if (!Number.isInteger(revision) || revision < 1) {
    io.err(`${c.red}--revision must be a positive integer, got "${raw}".${c.reset}`);
    return 1;
  }
  const item = service?.get(id);
  if (!service || !item) return notFound(id, io);
  const read = service.getRevision(id, revision);
  if (!read) {
    io.err(`${c.red}${id} has no revision ${revision}.${c.reset}`);
    return 1;
  }

  // The bound approve: the revision the operator named and THAT revision's own
  // hash travel into the store's conditional UPDATE. Revisions are immutable,
  // so this is the hash of the text `show` printed for that revision.
  const result = service.approve({
    itemId: id,
    revision,
    contentHash: read.contentHash,
    decidedBy,
  });
  if (!result.ok) {
    if (result.code === 'conflict') {
      io.err(
        `${c.red}Not approved: ${id} changed since you viewed it — revision ${item.revision} is current.${c.reset}`,
      );
      io.err(`Read it with \`ethos outbox show ${id}\`, then approve that revision.`);
    } else {
      io.err(`${c.red}Not approved: ${result.error}${c.reset}`);
    }
    return 1;
  }
  io.out(
    `${c.green}approved${c.reset} ${id} revision ${revision}. Nothing was sent from here — the gateway holding ${result.value.botKey} publishes it on its next poll.`,
  );
  return 0;
}

function reject(
  id: string,
  args: readonly string[],
  service: OutboxService | null,
  io: OutboxCliIo,
  decidedBy: string,
): number {
  if (!service?.get(id)) return notFound(id, io);
  const result = service.reject({
    itemId: id,
    reason: flagValue(args, '--reason') ?? 'rejected from the command line',
    decidedBy,
  });
  if (!result.ok) {
    io.err(`${c.red}Not rejected: ${result.error}${c.reset}`);
    return 1;
  }
  io.out(`${c.red}rejected${c.reset} ${id}. Nothing will be sent.`);
  return 0;
}

// --- Helpers -----------------------------------------------------------------

function destination(item: OutboxItem): string {
  return `${item.platform}:${item.chatId}${item.threadId ? ` (thread ${item.threadId})` : ''}`;
}

function notFound(id: string, io: OutboxCliIo): number {
  io.err(`${c.red}No outbox item ${id}.${c.reset}`);
  return 1;
}

function operatorLabel(): string {
  try {
    return `cli:${userInfo().username}`;
  } catch {
    return 'cli';
  }
}

function withId(args: readonly string[], io: OutboxCliIo, run: (id: string) => number): number {
  const id = positional(args);
  if (!id) {
    io.err(`${c.red}An outbox item id is required.${c.reset}`);
    for (const line of USAGE) io.err(line);
    return 1;
  }
  return run(id);
}

function positional(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    if (VALUE_FLAGS.has(arg)) {
      i++;
      continue;
    }
    if (!arg.startsWith('--')) return arg;
  }
  return undefined;
}

function flagValue(args: readonly string[], flag: string): string | undefined {
  const at = args.indexOf(flag);
  if (at === -1) return undefined;
  return args[at + 1];
}

function table(header: string[], rows: string[][]): string[] {
  const widths = header.map((h, col) =>
    Math.max(h.length, ...rows.map((r) => (r[col] ?? '').length)),
  );
  const render = (cells: string[]) =>
    cells
      .map((cell, col) => cell.padEnd(widths[col] ?? 0))
      .join('  ')
      .trimEnd();
  return [`${c.bold}${render(header)}${c.reset}`, ...rows.map(render)];
}
