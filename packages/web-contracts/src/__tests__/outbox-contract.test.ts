import { describe, expect, it } from 'vitest';
import { contract } from '../router';
import { OutboxItemViewSchema, OutboxStateSchema } from '../schemas';

// O-T9 — the wire shape of the personality approval outbox.
//
// Two things here are load-bearing and would be easy to lose in a refactor: the
// namespace writes DECISIONS ONLY (no send / claim / deliver procedure, because
// web-api holds no adapters), and `approve` carries the binding the human read.

describe('outbox contract', () => {
  it('exposes the seven decision + read procedures and nothing that sends', () => {
    expect(Object.keys(contract.outbox).sort()).toEqual([
      'approve',
      'edit',
      'get',
      'list',
      'reject',
      'retry',
      'revoke',
    ]);
  });

  it('an approve without the revision and hash the human read does not parse', () => {
    const schema = contract.outbox.approve['~orpc'].inputSchema;
    expect(schema).toBeDefined();
    const parse = (value: unknown) => schema?.['~standard'].validate(value);
    expect(parse({ itemId: 'obx_1', clientId: 'tab-A' })).toHaveProperty('issues');
    expect(
      parse({ itemId: 'obx_1', revision: 1, contentHash: 'a'.repeat(64), clientId: 'tab-A' }),
    ).not.toHaveProperty('issues');
  });

  it('an item view carries the full text, untruncated, plus the hash to approve', () => {
    const item = {
      id: 'obx_1',
      personalityId: 'cmo',
      botKey: 'bot-a',
      platform: 'telegram',
      chatId: '-100',
      threadId: null,
      revision: 2,
      contentHash: 'a'.repeat(64),
      text: 'Ethos 0.9 is out.\n\n— the team  ',
      state: 'awaiting_approval' as const,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_001,
      approverPersonality: 'brand-editor',
      review: {
        verdict: 'fail' as const,
        reasons: "'SOC2 certified' is not in truth-pack.md",
        revision: 1,
        reviewedAt: 1_700_000_000_000,
      },
      approvedBy: null,
      approvedAt: null,
      approvedRevision: null,
      claimedAt: null,
      sentAt: null,
      obligationId: null,
      failureReason: null,
      rejectionReason: null,
      originSessionKey: 'telegram:bot-a:-100',
    };
    // Byte-exact — trailing whitespace included. The approver approves bytes.
    expect(OutboxItemViewSchema.parse(item)).toEqual(item);
  });

  it('rejects a state outside the lifecycle', () => {
    expect(OutboxStateSchema.safeParse('queued').success).toBe(false);
    expect(OutboxStateSchema.options).toHaveLength(9);
  });
});
