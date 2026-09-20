import { InMemoryStorage } from '@ethosagent/storage-fs';
import type { ApprovalDecisionEvent } from '@ethosagent/types';
import type { ApprovalRequest } from '@ethosagent/web-contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AllowlistRepository } from '../../repositories/allowlist.repository';
import { ApprovalsService } from '../../services/approvals.service';
import {
  createTelegramApprovalBridge,
  type TelegramApprovalSurface,
} from '../../services/telegram-approval-bridge';

const OWNER = '4242';

describe('Telegram approval bridge (S10)', () => {
  let approvals: ApprovalsService;
  let adapter: {
    postApprovalCard: ReturnType<typeof vi.fn>;
    editToPlainText: ReturnType<typeof vi.fn>;
  };
  let bridge: ReturnType<typeof createTelegramApprovalBridge>;

  beforeEach(() => {
    approvals = new ApprovalsService({
      allowlist: new AllowlistRepository({ dataDir: '/data', storage: new InMemoryStorage() }),
      timeoutMs: 0,
    });
    adapter = {
      postApprovalCard: vi.fn(async () => ({ messageTs: '77' })),
      editToPlainText: vi.fn(async () => ({ ok: true })),
    };
    bridge = createTelegramApprovalBridge({
      approvals,
      ownerChatId: () => OWNER,
      adapter: () => adapter as unknown as TelegramApprovalSurface,
    });
  });

  /** Raise an approval and wait until its card is posted. */
  async function raise(): Promise<{ request: ApprovalRequest; decision: Promise<unknown> }> {
    const pending = new Promise<ApprovalRequest>((resolve) => {
      const off = approvals.onPending((_, req) => {
        off();
        resolve(req);
      });
    });
    const decision = approvals.requestApproval({
      sessionId: 's1',
      toolCallId: 'tc1',
      toolName: 'terminal',
      args: { command: 'rm -rf /tmp/x' },
    });
    const request = await pending;
    await vi.waitFor(() => expect(adapter.postApprovalCard).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0)); // let the post's `.then` record the card
    return { request, decision };
  }

  function tap(approvalId: string, decision: 'allow' | 'deny'): ApprovalDecisionEvent {
    return { approvalId, decision, decidedBy: 'mitesh', channelId: OWNER, messageTs: '77' };
  }

  it('posts one message with Approve/Deny to the owner chat on pending', async () => {
    const { request } = await raise();
    expect(adapter.postApprovalCard).toHaveBeenCalledTimes(1);
    expect(adapter.postApprovalCard).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: OWNER,
        approvalId: request.approvalId,
        toolName: 'terminal',
      }),
    );
    // The adapter builds the two buttons from this id; both must fit Telegram's 64-byte cap.
    expect(Buffer.byteLength(`approve:${request.approvalId}`)).toBeLessThanOrEqual(64);
  });

  it('a Telegram approve resolves the approval once and edits the message', async () => {
    const approve = vi.spyOn(approvals, 'approve');
    const { request, decision } = await raise();
    bridge.decide(tap(request.approvalId, 'allow'));
    await expect(decision).resolves.toEqual({ decision: 'allow' });
    expect(approve).toHaveBeenCalledTimes(1);
    expect(approve).toHaveBeenCalledWith(request.approvalId, 'once', 'human:telegram:mitesh');
    expect(adapter.editToPlainText).toHaveBeenCalledWith(
      OWNER,
      '77',
      expect.stringContaining('✓ allowed'),
    );
  });

  it('a decision made elsewhere edits the message and a later tap decides nothing', async () => {
    const approve = vi.spyOn(approvals, 'approve');
    const { request, decision } = await raise();
    await approvals.deny(request.approvalId, undefined, 'human:key:phone');
    await expect(decision).resolves.toMatchObject({ decision: 'deny' });
    expect(adapter.editToPlainText).toHaveBeenCalledWith(
      OWNER,
      '77',
      expect.stringContaining('✗ denied'),
    );
    bridge.decide(tap(request.approvalId, 'allow'));
    await Promise.resolve();
    expect(approve).not.toHaveBeenCalled();
  });

  it('ignores a tap on an id it did not post, or from another chat', async () => {
    const approve = vi.spyOn(approvals, 'approve');
    const { request } = await raise();
    bridge.decide(tap('not-ours', 'allow'));
    bridge.decide({ ...tap(request.approvalId, 'allow'), channelId: '999' });
    expect(approve).not.toHaveBeenCalled();
    expect(approvals.pendingCount()).toBe(1);
  });

  it('posts nothing when no owner chat is configured', async () => {
    approvals = new ApprovalsService({
      allowlist: new AllowlistRepository({ dataDir: '/data', storage: new InMemoryStorage() }),
      timeoutMs: 0,
    });
    createTelegramApprovalBridge({
      approvals,
      ownerChatId: () => undefined,
      adapter: () => adapter as unknown as TelegramApprovalSurface,
    });
    const pending = new Promise<void>((resolve) => approvals.onPending(() => resolve()));
    void approvals.requestApproval({
      sessionId: 's1',
      toolCallId: 'tc1',
      toolName: 'terminal',
      args: {},
    });
    await pending;
    expect(adapter.postApprovalCard).not.toHaveBeenCalled();
  });
});
