// `ethos outbox` — the terminal approval path for the personality approval
// outbox (plan `trust-before-reach.md` Part 2).
//
// The command is a printer over `OutboxService`. What is pinned here is what an
// operator relies on before a post reaches real people: `show` prints the exact
// bytes that will go out, and `approve` binds to the revision they read — a
// stale one approves nothing — through the same service, and the same one audit
// row, as the web pane and the Telegram card.

import {
  OUTBOX_AUDIT_CODES,
  type OutboxObservability,
  OutboxService,
  SQLiteOutboxStore,
} from '@ethosagent/outbox';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DRAFT_BEGIN, DRAFT_END, runOutboxCommand } from '../outbox';

type AuditRow = Parameters<OutboxObservability['recordSafetyApproval']>[0];

/** Leading spaces, a blank line, a tab, a trailing space and no final newline:
 *  every place a printer that trims or re-wraps would change the bytes. */
const DRAFT =
  '  Launch notes:\n\n\t• tabs stay, and so does this trailing space \nno final newline';

let service: OutboxService;
let audit: AuditRow[];
let out: string[];
let err: string[];
let raw: string[];
const io = {
  out: (l: string) => out.push(l),
  err: (l: string) => err.push(l),
  write: (r: string) => raw.push(r),
};

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const plain = (lines: string[]) => lines.join('\n').replace(ANSI, '');

beforeEach(() => {
  audit = [];
  out = [];
  err = [];
  raw = [];
  service = new OutboxService({
    store: new SQLiteOutboxStore(':memory:'),
    observability: { recordSafetyApproval: (row) => audit.push(row) },
  });
});

afterEach(() => {
  service.close();
});

function propose() {
  return service.propose({
    personalityId: 'writer',
    botKey: 'example-bot',
    platform: 'telegram',
    chatId: '-100200300',
    text: DRAFT,
  }).item;
}

const approvals = () => audit.filter((row) => row.code === OUTBOX_AUDIT_CODES.approve);

describe('ethos outbox show', () => {
  it('prints the byte-exact draft between the markers', () => {
    const item = propose();
    expect(runOutboxCommand(['show', item.id], service, io)).toBe(0);
    expect(raw.join('')).toBe(`${DRAFT_BEGIN}\n${DRAFT}\n${DRAFT_END}\n`);
  });

  it('prints the destination, the sender, the hash and the approve command for that revision', () => {
    const item = propose();
    runOutboxCommand(['show', item.id], service, io);
    const text = plain(out);
    expect(text).toContain('telegram:-100200300');
    expect(text).toContain('example-bot');
    expect(text).toContain(item.contentHash);
    expect(text).toContain(`ethos outbox approve ${item.id} --revision 1`);
  });

  it('refuses an unknown id, and a machine with no outbox.db', () => {
    expect(runOutboxCommand(['show', 'obx_missing'], service, io)).toBe(1);
    expect(runOutboxCommand(['show', 'obx_missing'], null, io)).toBe(1);
    expect(plain(err)).toContain('No outbox item obx_missing');
  });
});

describe('ethos outbox approve', () => {
  it('approves through OutboxService with the bound revision and hash, writing one outbox.approve row', () => {
    const item = propose();
    const spy = vi.spyOn(service, 'approve');

    expect(
      runOutboxCommand(['approve', item.id, '--revision', '1'], service, io, 'cli:tester'),
    ).toBe(0);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith({
      itemId: item.id,
      revision: 1,
      contentHash: item.contentHash,
      decidedBy: 'cli:tester',
    });
    expect(service.get(item.id)).toMatchObject({
      state: 'approved',
      approvedBy: 'cli:tester',
      approvedRevision: 1,
    });
    expect(approvals()).toHaveLength(1);
    expect(approvals()[0]?.details).toMatchObject({ itemId: item.id, revision: 1 });
    // Approving is a row, not a send.
    expect(plain(out)).toContain('Nothing was sent from here');
  });

  it('refuses a stale revision and approves nothing', () => {
    const item = propose();
    const edited = service.edit({
      itemId: item.id,
      revision: 1,
      text: `${DRAFT} (edited)`,
      decidedBy: 'web',
    });
    expect(edited.ok).toBe(true);

    expect(runOutboxCommand(['approve', item.id, '--revision', '1'], service, io)).toBe(1);

    expect(plain(err)).toContain('changed since you viewed it');
    expect(service.get(item.id)).toMatchObject({ state: 'awaiting_approval', revision: 2 });
    expect(approvals()).toHaveLength(0);
  });

  it('refuses without --revision, so nobody approves text they have not named', () => {
    const item = propose();
    expect(runOutboxCommand(['approve', item.id], service, io)).toBe(1);
    expect(plain(err)).toContain('--revision');
    expect(service.get(item.id)?.state).toBe('awaiting_approval');
    expect(approvals()).toHaveLength(0);
  });
});

describe('ethos outbox reject', () => {
  it('rejects through the service with the reason, writing one outbox.reject row', () => {
    const item = propose();
    expect(
      runOutboxCommand(['reject', item.id, '--reason', 'wrong channel'], service, io, 'cli:tester'),
    ).toBe(0);
    expect(service.get(item.id)).toMatchObject({
      state: 'rejected',
      rejectionReason: 'wrong channel',
    });
    expect(audit.filter((row) => row.code === OUTBOX_AUDIT_CODES.reject)).toHaveLength(1);
  });
});

describe('ethos outbox list', () => {
  it('lists what is waiting, and hides decided items unless --all', () => {
    const waiting = propose();
    const decided = service.propose({
      personalityId: 'writer',
      botKey: 'example-bot',
      platform: 'telegram',
      chatId: '-100200300',
      text: 'a second draft',
    }).item;
    service.reject({ itemId: decided.id, reason: 'no', decidedBy: 'web' });

    expect(runOutboxCommand(['list'], service, io)).toBe(0);
    expect(plain(out)).toContain(waiting.id);
    expect(plain(out)).not.toContain(decided.id);

    out = [];
    runOutboxCommand(['list', '--all'], service, io);
    expect(plain(out)).toContain(decided.id);
  });

  it('says nothing is waiting on a machine with no outbox.db', () => {
    expect(runOutboxCommand(['list'], null, io)).toBe(0);
    expect(plain(out)).toContain('Nothing is waiting for approval.');
  });
});
