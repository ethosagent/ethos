import { describe, expect, it, vi } from 'vitest';
import { APPROVAL_NOTE_INPUT_ID } from '../blocks/approval';
import { registerInteractionHandler } from '../events/interactions';
import { DiscordAdapter } from '../index';
import { loadDiscordSdk } from '../sdk';

type Handler = (interaction: unknown) => Promise<void>;

function setup() {
  let handler: Handler | undefined;
  const client = {
    on: (_event: string, h: unknown) => {
      handler = h as Handler;
    },
  };
  const ctx = {
    pendingInteractions: new Map(),
    onApprovalDecision: vi.fn(),
    onApprovalNoteRequest: vi.fn(),
    onApprovalNoteSubmit: vi.fn(),
    onClarifyInteraction: vi.fn(),
  };
  // biome-ignore lint/suspicious/noExplicitAny: fake client + partial ctx
  registerInteractionHandler(client as any, ctx as any);
  const fire = async (i: Record<string, unknown>) => {
    if (!handler) throw new Error('handler not registered');
    await handler(i);
  };
  return { ctx, fire };
}

const base = {
  isChatInputCommand: () => false,
  user: { id: 'U1' },
  channelId: 'C1',
  id: 'i1',
  token: 't',
};

describe('discord approval note interactions', () => {
  it('deny-note button opens the modal and emits no decision', async () => {
    const { ctx, fire } = setup();
    const interaction = {
      ...base,
      isButton: () => true,
      isModalSubmit: () => false,
      customId: 'ethos:denynote:a1',
      message: { id: 'M1' },
    };
    await fire(interaction);
    expect(ctx.onApprovalNoteRequest).toHaveBeenCalledWith('a1', 'U1', interaction);
    expect(ctx.onApprovalDecision).not.toHaveBeenCalled();
    expect(ctx.onClarifyInteraction).not.toHaveBeenCalled();
  });

  it('ethos:deny:a1 still denies without a note', async () => {
    const { ctx, fire } = setup();
    await fire({
      ...base,
      isButton: () => true,
      isModalSubmit: () => false,
      customId: 'ethos:deny:a1',
      message: { id: 'M1' },
    });
    expect(ctx.onApprovalDecision).toHaveBeenCalledWith('a1', 'deny', 'U1', expect.anything());
    expect(ctx.onApprovalNoteRequest).not.toHaveBeenCalled();
  });

  it('modal submit with the deny-note prefix routes to onApprovalNoteSubmit, not clarify', async () => {
    const { ctx, fire } = setup();
    const interaction = {
      ...base,
      isButton: () => false,
      isModalSubmit: () => true,
      customId: 'ethos:denynote:a1',
      fields: {
        getTextInputValue: (id: string) => (id === APPROVAL_NOTE_INPUT_ID ? '  use rg  ' : ''),
      },
    };
    await fire(interaction);
    expect(ctx.onApprovalNoteSubmit).toHaveBeenCalledWith('a1', 'U1', 'use rg', interaction);
    expect(ctx.onClarifyInteraction).not.toHaveBeenCalled();
  });
});

describe('DiscordAdapter approval note handling', () => {
  function makeAdapter(opts: { policy?: 'role_gate' | 'allow_any'; roles?: string[] } = {}) {
    const adapter = new DiscordAdapter({
      token: 'fake-token',
      botKey: 'test-bot',
      approvalPolicy: opts.policy ?? 'allow_any',
      approvalRoleIds: opts.roles ?? [],
    });
    const events: unknown[] = [];
    adapter.onApprovalDecision((e) => events.push(e));
    return { adapter, events };
  }

  function fakeInteraction(roles: string[] = [], kind: 'button' | 'modal' = 'modal') {
    return {
      isButton: () => kind === 'button',
      isModalSubmit: () => kind === 'modal',
      channelId: 'C1',
      message: { id: 'M1' },
      member: { roles: { cache: new Map(roles.map((r) => [r, true])) } },
      showModal: vi.fn(async () => {}),
      deferUpdate: vi.fn(async () => {}),
      reply: vi.fn(async () => {}),
    };
  }

  // The SDK is only needed to build the ModalBuilder.
  it('request shows the modal without deferring first', async () => {
    await loadDiscordSdk();
    const { adapter, events } = makeAdapter();
    const i = fakeInteraction([], 'button');
    adapter.handleApprovalNoteRequest('a1', 'U1', i as never);
    expect(i.showModal).toHaveBeenCalledTimes(1);
    expect(i.deferUpdate).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it('request is refused by the role gate (no modal)', async () => {
    await loadDiscordSdk();
    const { adapter } = makeAdapter({ policy: 'role_gate', roles: ['admin'] });
    const i = fakeInteraction(['nobody'], 'button');
    adapter.handleApprovalNoteRequest('a1', 'U1', i as never);
    expect(i.showModal).not.toHaveBeenCalled();
    expect(i.reply).toHaveBeenCalled();
  });

  it('submit re-checks the role gate and emits nothing when refused', () => {
    const { adapter, events } = makeAdapter({ policy: 'role_gate', roles: ['admin'] });
    const i = fakeInteraction(['nobody']);
    adapter.handleApprovalNoteSubmit('a1', 'U1', 'use rg', i as never);
    expect(events).toEqual([]);
    expect(i.deferUpdate).not.toHaveBeenCalled();
  });

  it('submit emits a deny with the note', () => {
    const { adapter, events } = makeAdapter({ policy: 'role_gate', roles: ['admin'] });
    const i = fakeInteraction(['admin']);
    adapter.handleApprovalNoteSubmit('a1', 'U1', 'use rg', i as never);
    expect(i.deferUpdate).toHaveBeenCalled();
    expect(events).toEqual([
      {
        approvalId: 'a1',
        decision: 'deny',
        decidedBy: 'U1',
        channelId: 'C1',
        messageTs: 'M1',
        note: 'use rg',
      },
    ]);
  });

  it('a blank note submitted via the modal is a plain deny (no note field)', () => {
    const { adapter, events } = makeAdapter();
    const i = fakeInteraction();
    adapter.handleApprovalNoteSubmit('a1', 'U1', '', i as never);
    expect(events).toEqual([
      { approvalId: 'a1', decision: 'deny', decidedBy: 'U1', channelId: 'C1', messageTs: 'M1' },
    ]);
  });
});
