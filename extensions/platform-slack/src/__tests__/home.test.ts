import { describe, expect, it, vi } from 'vitest';
import { type SessionSummary, sessionListBlocks } from '../blocks/session';
import { plaintextFallback } from '../blocks/shared';
import { registerHomeEvents } from '../home/handlers';
import { buildHomeView } from '../home/view';

// ---------------------------------------------------------------------------
// blocks/session — pure builder
// ---------------------------------------------------------------------------

describe('blocks/session', () => {
  it('renders an empty state when there are no sessions', () => {
    const blocks = sessionListBlocks({ sessions: [] });
    expect(plaintextFallback(blocks)).toContain('No recent sessions');
  });

  it('renders sessions in the order given, newest-first labels', () => {
    const sessions: SessionSummary[] = [
      { id: 's1', label: '#general', lastActivity: new Date('2026-05-10T10:00:00Z') },
      { id: 's2', label: 'thread in #ai-pair', lastActivity: new Date('2026-05-09T10:00:00Z') },
    ];
    const text = plaintextFallback(sessionListBlocks({ sessions }));
    expect(text.indexOf('#general')).toBeLessThan(text.indexOf('#ai-pair'));
  });

  it('renders a deep link when webUiBaseUrl is supplied', () => {
    const sessions: SessionSummary[] = [
      { id: 's1', label: '#general', lastActivity: new Date('2026-05-10T10:00:00Z') },
    ];
    const blocks = sessionListBlocks({ sessions, webUiBaseUrl: 'https://ethos.example.com' });
    const json = JSON.stringify(blocks);
    expect(json).toContain('https://ethos.example.com/sessions/s1');
  });

  it('renders plain text (no link) when webUiBaseUrl is absent', () => {
    const sessions: SessionSummary[] = [
      { id: 's1', label: '#general', lastActivity: new Date('2026-05-10T10:00:00Z') },
    ];
    const json = JSON.stringify(sessionListBlocks({ sessions }));
    expect(json).not.toContain('http');
  });

  it('escapes mrkdwn metacharacters in session labels', () => {
    const sessions: SessionSummary[] = [
      { id: 's1', label: '<!channel> sneaky', lastActivity: new Date('2026-05-10T10:00:00Z') },
    ];
    const json = JSON.stringify(sessionListBlocks({ sessions }));
    expect(json).not.toContain('<!channel>');
    expect(json).toContain('&lt;!channel&gt;');
  });
});

// ---------------------------------------------------------------------------
// home/view — pure View builder
// ---------------------------------------------------------------------------

describe('home/view — buildHomeView', () => {
  const personalityBinding = { type: 'personality' as const, name: 'researcher' };
  const teamBinding = { type: 'team' as const, name: 'eng' };

  it('produces a home View with the correct type', () => {
    const view = buildHomeView({
      bot: { displayName: 'Researcher', binding: personalityBinding },
      sessions: [],
      kanbanTickets: [],
      memorySnippets: [],
      channelModes: [],
    });
    expect(view.type).toBe('home');
    expect(Array.isArray(view.blocks)).toBe(true);
  });

  it('header shows the bot identity and binding', () => {
    const view = buildHomeView({
      bot: { displayName: 'Researcher', binding: personalityBinding },
      sessions: [],
      kanbanTickets: [],
      memorySnippets: [],
      channelModes: [],
    });
    const text = plaintextFallback(view.blocks);
    expect(text).toContain('Researcher');
    expect(text).toContain('researcher');
  });

  it('hides the kanban section for a personality-bound bot', () => {
    const view = buildHomeView({
      bot: { displayName: 'Researcher', binding: personalityBinding },
      sessions: [],
      kanbanTickets: [{ id: 't1', title: 'do thing', status: 'todo', assignee: null }],
      memorySnippets: [],
      channelModes: [],
    });
    expect(plaintextFallback(view.blocks)).not.toContain('Kanban');
  });

  it('shows the kanban section for a team-bound bot', () => {
    const view = buildHomeView({
      bot: { displayName: 'Eng', binding: teamBinding },
      sessions: [],
      kanbanTickets: [{ id: 't1', title: 'do thing', status: 'todo', assignee: null }],
      memorySnippets: [],
      channelModes: [],
    });
    expect(plaintextFallback(view.blocks)).toContain('Kanban');
  });

  it('renders the four sections plus a refresh button when data is present', () => {
    const view = buildHomeView({
      bot: { displayName: 'Eng', binding: teamBinding },
      sessions: [{ id: 's1', label: '#general', lastActivity: new Date('2026-05-10T10:00:00Z') }],
      kanbanTickets: [{ id: 't1', title: 'do thing', status: 'todo', assignee: 'alice' }],
      memorySnippets: ['- learned a thing'],
      channelModes: [['C1', 'all']],
    });
    const text = plaintextFallback(view.blocks);
    expect(text).toContain('Recent sessions');
    expect(text).toContain('Kanban');
    expect(text).toContain('Recent memory updates');
    expect(text).toContain('This bot is in');
    // refresh button is an actions block — find it in the raw view
    const json = JSON.stringify(view.blocks);
    expect(json).toContain('home:refresh');
  });

  it('shows tasteful placeholders when readers are unwired', () => {
    const view = buildHomeView({
      bot: { displayName: 'Eng', binding: teamBinding },
      sessions: [],
      kanbanTickets: [],
      memorySnippets: [],
      channelModes: [],
    });
    const text = plaintextFallback(view.blocks);
    expect(text).toContain('No recent sessions');
    expect(text).toContain('No recent memory updates');
    expect(text).toContain('not in any channels');
  });

  it('escapes mrkdwn in channel mode entries and memory snippets', () => {
    const view = buildHomeView({
      bot: { displayName: 'Eng', binding: teamBinding },
      sessions: [],
      kanbanTickets: [],
      memorySnippets: ['<!here> watch out'],
      channelModes: [['C1', 'all']],
    });
    const json = JSON.stringify(view.blocks);
    expect(json).not.toContain('<!here>');
    expect(json).toContain('&lt;!here&gt;');
  });
});

// ---------------------------------------------------------------------------
// home/handlers — registrar wired to a fake Bolt app
// ---------------------------------------------------------------------------

interface FakeApp {
  event: ReturnType<typeof vi.fn>;
  action: ReturnType<typeof vi.fn>;
  handlers: Map<string, (args: unknown) => Promise<void>>;
}

function fakeApp(): FakeApp {
  const handlers = new Map<string, (args: unknown) => Promise<void>>();
  return {
    handlers,
    event: vi.fn((name: string, fn: (args: unknown) => Promise<void>) => {
      handlers.set(`event:${name}`, fn);
    }),
    action: vi.fn((id: string, fn: (args: unknown) => Promise<void>) => {
      handlers.set(`action:${id}`, fn);
    }),
  };
}

describe('home/handlers — registerHomeEvents', () => {
  const deps = {
    binding: { type: 'team' as const, name: 'eng' },
    displayName: 'Eng',
    channelOverrides: { entries: () => [['C1', 'all']] as Array<[string, 'all']> },
    session: {
      recentSessions: async () => [
        { id: 's1', label: '#general', lastActivity: new Date('2026-05-10T10:00:00Z') },
      ],
    },
    memory: { read: async () => '- a memory entry', append: async () => {} },
    kanban: {
      listOpenTickets: async () => [
        { id: 't1', title: 'do thing', status: 'todo', assignee: null },
      ],
    },
  };

  it('registers app_home_opened and home:refresh', () => {
    const app = fakeApp();
    registerHomeEvents(app as never, deps);
    expect(app.handlers.has('event:app_home_opened')).toBe(true);
    expect(app.handlers.has('action:home:refresh')).toBe(true);
  });

  it('publishes a home view on app_home_opened', async () => {
    const app = fakeApp();
    registerHomeEvents(app as never, deps);
    const publish = vi.fn().mockResolvedValue(undefined);
    const handler = app.handlers.get('event:app_home_opened');
    if (!handler) throw new Error('handler not registered');
    await handler({
      event: { user: 'U123', tab: 'home' },
      client: { views: { publish } },
    });
    expect(publish).toHaveBeenCalledTimes(1);
    const arg = publish.mock.calls[0]?.[0] as { user_id: string; view: { type: string } };
    expect(arg.user_id).toBe('U123');
    expect(arg.view.type).toBe('home');
  });

  it('ignores app_home_opened events for non-home tabs', async () => {
    const app = fakeApp();
    registerHomeEvents(app as never, deps);
    const publish = vi.fn().mockResolvedValue(undefined);
    const handler = app.handlers.get('event:app_home_opened');
    if (!handler) throw new Error('handler not registered');
    await handler({
      event: { user: 'U123', tab: 'messages' },
      client: { views: { publish } },
    });
    expect(publish).not.toHaveBeenCalled();
  });

  it('re-publishes the view on a home:refresh click and acks', async () => {
    const app = fakeApp();
    registerHomeEvents(app as never, deps);
    const publish = vi.fn().mockResolvedValue(undefined);
    const ack = vi.fn().mockResolvedValue(undefined);
    const handler = app.handlers.get('action:home:refresh');
    if (!handler) throw new Error('handler not registered');
    await handler({
      ack,
      body: { user: { id: 'U999' } },
      client: { views: { publish } },
    });
    expect(ack).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledTimes(1);
    const arg = publish.mock.calls[0]?.[0] as { user_id: string };
    expect(arg.user_id).toBe('U999');
  });

  it('degrades gracefully when readers are absent', async () => {
    const app = fakeApp();
    registerHomeEvents(app as never, {
      binding: { type: 'personality', name: 'researcher' },
      displayName: 'Researcher',
      channelOverrides: undefined,
      session: undefined,
      memory: undefined,
      kanban: undefined,
    });
    const publish = vi.fn().mockResolvedValue(undefined);
    const handler = app.handlers.get('event:app_home_opened');
    if (!handler) throw new Error('handler not registered');
    await handler({
      event: { user: 'U123', tab: 'home' },
      client: { views: { publish } },
    });
    expect(publish).toHaveBeenCalledTimes(1);
    const arg = publish.mock.calls[0]?.[0] as { view: { type: string } };
    expect(arg.view.type).toBe('home');
  });

  it('swallows a views.publish failure so a bad event never crashes Bolt', async () => {
    const app = fakeApp();
    registerHomeEvents(app as never, deps);
    const publish = vi.fn().mockRejectedValue(new Error('slack down'));
    const handler = app.handlers.get('event:app_home_opened');
    if (!handler) throw new Error('handler not registered');
    await expect(
      handler({ event: { user: 'U123', tab: 'home' }, client: { views: { publish } } }),
    ).resolves.toBeUndefined();
  });
});
