// plan personality-presence-and-initiative §7 — getting to know the user, with
// consent. Three pieces, pinned here:
//
// - `createFirstContactInjector` (../first-contact.ts) adds ONE tail line only on
//   a private turn, for a sender whose `user:<id>` USER.md is empty, with a
//   personality that lists the `get-to-know-you` skill.
// - `createConsentRequiredToolsHook`: while that first-contact flag is set,
//   every tool outside a small allowlist needs the user's explicit yes THIS
//   turn, to a "May I …?" question the assistant asked just before, and one
//   yes buys ONE such call (a lookup OR a memory write). Tools that start work
//   outside this session (delegate_task and friends) are refused outright.
//   The flag stays set for the rest of the session once it starts.
// - Through a real `AgentLoop`: a refused call is persisted as an error
//   tool_result and never executed; after a yes it runs and the write lands in
//   `user:<id>/USER.md`; after a no nothing is written.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AgentLoop,
  DefaultHookRegistry,
  DefaultPersonalityRegistry,
  DefaultToolRegistry,
  InMemorySessionStore,
} from '@ethosagent/core';
import { MarkdownFileMemoryProvider } from '@ethosagent/memory-markdown';
import { bundledSkillsSource } from '@ethosagent/skills';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import { createMemoryTools } from '@ethosagent/tools-memory';
import type {
  AgentEvent,
  CompletionChunk,
  CompletionOptions,
  LLMProvider,
  MemoryContext,
  PersonalityConfig,
  PromptContext,
  StoredMessage,
  ToolResult,
} from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import {
  askedForConsent,
  composeFirstContact,
  createConsentRequiredToolsHook,
  createFirstContactInjector,
  createSpentCallCloser,
  FIRST_CONTACT_ALLOWED_TOOLS,
  FIRST_CONTACT_REFUSED_TOOLS,
  FirstContactSessions,
  GET_TO_KNOW_YOU_SKILL,
  isExplicitYes,
} from '../first-contact';
import { createTestSafety } from './helpers/wiring-test-safety';

const USER_ID = 'u-alice';
const DATA_DIR = '/ethos';

const friend: PersonalityConfig = {
  id: 'friend',
  name: 'Friend',
  skills: { global_ingest: { allow: [GET_TO_KNOW_YOU_SKILL] } },
};
const plain: PersonalityConfig = { id: 'plain', name: 'Plain' };

function registry(): DefaultPersonalityRegistry {
  const r = new DefaultPersonalityRegistry();
  r.define(friend);
  r.define(plain);
  return r;
}

function memory(storage = new InMemoryStorage()): MarkdownFileMemoryProvider {
  return new MarkdownFileMemoryProvider({ dir: DATA_DIR, storage });
}

function userCtx(userId = USER_ID): MemoryContext {
  return {
    scopeId: `user:${userId}`,
    sessionId: 's',
    sessionKey: 'k',
    platform: 'telegram',
    workingDir: '/',
  };
}

function userMessage(content: string, id = 'm1'): StoredMessage {
  return { id, sessionId: 's1', role: 'user', content, timestamp: new Date(0) };
}

function assistantMessage(content: string, id = 'a1'): StoredMessage {
  return { id, sessionId: 's1', role: 'assistant', content, timestamp: new Date(0) };
}

function promptCtx(over: Partial<PromptContext> = {}): PromptContext {
  return {
    sessionId: 's1',
    sessionKey: 'telegram:bot:chat',
    platform: 'telegram',
    model: 'mock',
    history: [userMessage('hi')],
    isDm: true,
    turnNumber: 1,
    personalityId: 'friend',
    userId: USER_ID,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// The skill
// ---------------------------------------------------------------------------

describe('get-to-know-you skill', () => {
  it('is bundled and carries the one-question-per-lookup consent rule', () => {
    const raw = readFileSync(
      join(bundledSkillsSource().dir, 'personal', 'get-to-know-you', 'SKILL.md'),
      'utf8',
    );
    expect(raw).toContain('May I look up');
    expect(raw).toContain('May I remember');
    expect(raw).toContain('memory_write');
    expect(raw).toContain('store=user');
    // Consent questions are always "May I …?" (`CONSENT_QUESTION` also takes
    // "Can I look/search/…", but the skill never asks the model to use it).
    expect(raw).toContain('Always phrase it "May I …?"');
    expect(raw).not.toMatch(/starting "May I" or "Can I"/);
  });

  it('tells the model that one yes allows ONE call, and that delegation is refused', () => {
    const raw = readFileSync(
      join(bundledSkillsSource().dir, 'personal', 'get-to-know-you', 'SKILL.md'),
      'utf8',
    );
    expect(raw).toMatch(/one yes allows one call/i);
    expect(raw).toContain('delegate_task');
  });
});

// ---------------------------------------------------------------------------
// isExplicitYes
// ---------------------------------------------------------------------------

describe('isExplicitYes', () => {
  it.each(['yes', 'Yes!', 'yes please', 'sure', 'sure.', 'go ahead', 'yeah, go ahead'])(
    'accepts %j',
    (text) => {
      expect(isExplicitYes(text)).toBe(true);
    },
  );

  it.each([
    'no',
    'not now',
    'yes but do not look anything up',
    'hi there',
    'I guess',
    'who are you?',
    'ok',
    'Okay.',
    'ok thanks',
    'yes ok',
    '',
  ])('refuses %j', (text) => {
    expect(isExplicitYes(text)).toBe(false);
  });

  it('reads only the last paragraph, so a voice or attachment annotation does not hide the yes', () => {
    expect(isExplicitYes('[voice note, 2s]\n\nyes')).toBe(true);
  });
});

describe('askedForConsent', () => {
  it.each([
    'Nice to meet you. May I remember that your name is Alice?',
    'May I look up your company website?',
    'can I search for that talk you gave?',
    'Can I check your GitHub profile?',
    'Can I note that you prefer short answers?',
    'May I remove that you live in Paris?',
  ])('accepts %j', (text) => {
    expect(askedForConsent(text)).toBe(true);
  });

  it.each([
    'Hi! What can I help with today?',
    'May I say, that is a great name.',
    'Great. What should I call you?',
    'Can I help you with anything else?',
    'Done. Can I get you anything?',
    '',
  ])('refuses %j', (text) => {
    expect(askedForConsent(text)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The injector
// ---------------------------------------------------------------------------

describe('createFirstContactInjector', () => {
  function make(mem = memory()) {
    const sessions = new FirstContactSessions();
    const injector = createFirstContactInjector({
      memory: mem,
      personalities: registry(),
      sessions,
    });
    return { sessions, injector };
  }

  it('adds one tail line on a private first contact with a personality that lists the skill', async () => {
    const { sessions, injector } = make();
    const result = await injector.inject(promptCtx());
    expect(result?.position).toBe('append');
    expect(result?.content.split('\n')).toHaveLength(1);
    expect(result?.content).toContain(GET_TO_KNOW_YOU_SKILL);
    expect(sessions.get('s1')?.gated).toBe(true);
  });

  it('emits byte-identical content on consecutive turns (prefix-cache safe)', async () => {
    const { injector } = make();
    const a = await injector.inject(promptCtx({ turnNumber: 1 }));
    const b = await injector.inject(promptCtx({ turnNumber: 5, history: [userMessage('yes')] }));
    expect(a?.content).toBe(b?.content);
  });

  it('records a yes only when the assistant asked a "May I …?" question just before it', async () => {
    const { sessions, injector } = make();
    await injector.inject(
      promptCtx({
        history: [assistantMessage('May I look up your blog?'), userMessage('yes', 'm-yes')],
      }),
    );
    expect(sessions.get('s1')?.yesMessageId).toBe('m-yes');

    // A bare yes with no preceding question is not consent.
    await injector.inject(promptCtx({ history: [userMessage('yes', 'm-yes2')] }));
    expect(sessions.get('s1')?.gated).toBe(true);
    expect(sessions.get('s1')?.yesMessageId).toBeUndefined();

    // Nor is "ok thanks" after a question.
    await injector.inject(
      promptCtx({
        history: [assistantMessage('May I look up your blog?'), userMessage('ok thanks', 'm3')],
      }),
    );
    expect(sessions.get('s1')?.yesMessageId).toBeUndefined();
  });

  it('keeps the gate for the rest of the session once first contact started, even after USER.md fills', async () => {
    const mem = memory();
    const { sessions, injector } = make(mem);
    expect(await injector.inject(promptCtx())).not.toBeNull();
    await mem.sync([{ action: 'add', key: 'USER.md', content: 'Name: Alice' }], userCtx());
    // The line goes (the profile is no longer empty) but the gate stays.
    expect(await injector.inject(promptCtx({ turnNumber: 3 }))).toBeNull();
    expect(sessions.get('s1')?.gated).toBe(true);
    // A different session for the same, now-known user is not gated.
    await injector.inject(promptCtx({ sessionId: 's2' }));
    expect(sessions.get('s2')?.gated).toBe(false);
  });

  it('fails CLOSED when the profile read throws: no turn failure, and the session is gated', async () => {
    const mem = memory();
    vi.spyOn(mem, 'read').mockRejectedValue(new Error('disk gone'));
    const { sessions, injector } = make(mem);
    await expect(injector.inject(promptCtx())).resolves.toBeNull();
    expect(sessions.get('s1')?.gated).toBe(true);
  });

  it('is absent when the sender USER.md has content', async () => {
    const mem = memory();
    await mem.sync([{ action: 'add', key: 'USER.md', content: 'Name: Alice' }], userCtx());
    const { sessions, injector } = make(mem);
    expect(await injector.inject(promptCtx())).toBeNull();
    expect(sessions.get('s1')?.gated).toBe(false);
  });

  it('is absent in a shared room', async () => {
    const { sessions, injector } = make();
    expect(await injector.inject(promptCtx({ isDm: false }))).toBeNull();
    expect(sessions.get('s1')?.gated).toBe(false);
  });

  it('is absent for a personality without the skill', async () => {
    const { sessions, injector } = make();
    expect(await injector.inject(promptCtx({ personalityId: 'plain' }))).toBeNull();
    expect(sessions.get('s1')?.gated).toBe(false);
  });

  it('is absent when the skill is listed but also denied', async () => {
    const r = registry();
    r.define({
      id: 'friend',
      name: 'Friend',
      skills: { global_ingest: { allow: [GET_TO_KNOW_YOU_SKILL], deny: [GET_TO_KNOW_YOU_SKILL] } },
    });
    const sessions = new FirstContactSessions();
    const injector = createFirstContactInjector({ memory: memory(), personalities: r, sessions });
    expect(await injector.inject(promptCtx())).toBeNull();
  });

  it('is absent with no sender id — there is no user:<id> profile to fill', async () => {
    const { injector } = make();
    expect(await injector.inject(promptCtx({ userId: undefined }))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The consent hook
// ---------------------------------------------------------------------------

describe('createConsentRequiredToolsHook', () => {
  const call = (
    toolName: string,
    args: unknown = {},
    toolCallId = 't1',
    personalityId?: string,
  ) => ({
    sessionId: 's1',
    toolCallId,
    toolName,
    args,
    ...(personalityId ? { personalityId } : {}),
  });

  function gated(yes: string | undefined = undefined) {
    const sessions = new FirstContactSessions();
    sessions.gate('s1', yes);
    return { sessions, hook: createConsentRequiredToolsHook(sessions) };
  }

  function gatedWithAfter(yes: string | undefined = undefined) {
    const { sessions, hook } = gated(yes);
    const after = async (c: ReturnType<typeof call>) =>
      createSpentCallCloser(sessions)({
        ...c,
        workingDir: '/',
        result: { ok: true, value: '' },
        durationMs: 1,
      });
    return { sessions, hook, after };
  }

  it('has no opinion on a session that is not gated', async () => {
    const sessions = new FirstContactSessions();
    sessions.clear('s1');
    const hook = createConsentRequiredToolsHook(sessions);
    expect(await hook(call('web_search'))).toEqual({});
    expect(await hook(call('delegate_task'))).toEqual({});
  });

  it('gates by default: any tool off the allowlist needs a yes (terminal, browser, MCP, a2a, web, run_code)', async () => {
    const { hook } = gated();
    for (const name of [
      'web_search',
      'terminal',
      'run_code',
      'browser_click',
      'browser_screenshot',
      'mcp__github__search_users',
      'a2a_send',
      'read_file',
      'some_future_tool',
    ]) {
      expect((await hook(call(name))).error, name).toMatch(/consent/);
    }
  });

  it('lets the allowlisted harmless tools through without a yes', async () => {
    const { hook } = gated();
    for (const name of FIRST_CONTACT_ALLOWED_TOOLS) {
      expect(await hook(call(name)), name).toEqual({});
    }
    expect(FIRST_CONTACT_ALLOWED_TOOLS).not.toContain('memory_write');
    expect(FIRST_CONTACT_ALLOWED_TOOLS).not.toContain('team_memory_write');
  });

  it('gates every memory write, not only store=user', async () => {
    const { hook } = gated();
    expect((await hook(call('memory_write', { store: 'user' }))).error).toMatch(/consent/);
    expect((await hook(call('memory_write', { store: 'memory' }))).error).toMatch(/consent/);
    expect((await hook(call('team_memory_write', { action: 'add', key: 'x' }))).error).toMatch(
      /consent/,
    );
  });

  it('refuses tools that start work outside this session outright, even after a yes', async () => {
    const { hook } = gated('m-yes');
    for (const name of [
      'delegate_task',
      'dispatch_team',
      'route_to_agent',
      'mixture_of_agents',
      'broadcast_to_agents',
      'a2a_send',
      'cron',
      'watcher_create',
      'goal_create',
      'kanban_create',
      'kanban_assign',
      'kanban_update_status',
      'kanban_unblock',
      'kanban_complete',
      'process_start',
      'watcher_resume',
      'send_message',
      'call',
      'meet_join',
      'voice_session',
    ]) {
      expect(FIRST_CONTACT_REFUSED_TOOLS, name).toContain(name);
      expect((await hook(call(name, {}, `c-${name}`))).error, name).toMatch(/not available/);
    }
    // None of those refusals spent the yes.
    expect(await hook(call('web_search', {}, 'c-lookup'))).toEqual({});
  });

  it('yes → one lookup; a second lookup or a write in the same turn is refused', async () => {
    const { hook } = gated('m-yes');
    expect(await hook(call('web_search', {}, 't1'))).toEqual({});
    // A second fire for the SAME call (after an argument rewrite) is not a second call.
    expect(await hook(call('web_search', {}, 't1'))).toEqual({});
    expect((await hook(call('web_search', {}, 't2'))).error).toMatch(/one call/);
    expect((await hook(call('memory_write', { store: 'user' }, 't3'))).error).toMatch(/one call/);
  });

  it('a text-transport id reused on the next step is a new call, refused after the yes is spent', async () => {
    // The text-xml transport restarts `text-tool-N` every complete() call, so
    // step 2's `text-tool-0` is a different call than step 1's.
    const { sessions, hook, after } = gatedWithAfter('m-yes');
    const q = { query: 'Alice' };
    expect(await hook(call('web_search', q, 'text-tool-0'))).toEqual({});
    await after(call('web_search', q, 'text-tool-0'));
    expect((await hook(call('web_search', q, 'text-tool-0'))).error).toMatch(/one call/);
    expect((await hook(call('web_search', { query: 'Bob' }, 'text-tool-0'))).error).toMatch(
      /one call/,
    );
    expect(sessions.isGated('s1')).toBe(true);
  });

  it('an empty call id never matches the spent call', async () => {
    const { hook } = gated('m-yes');
    expect(await hook(call('web_search', { query: 'a' }, ''))).toEqual({});
    expect((await hook(call('web_search', { query: 'a' }, ''))).error).toMatch(/one call/);
    expect((await hook(call('memory_write', { store: 'user' }, ''))).error).toMatch(/one call/);
  });

  it('the same id with another tool or other args in the same step is a different call', async () => {
    const { hook } = gated('m-yes');
    expect(await hook(call('web_search', { query: 'a' }, 't1'))).toEqual({});
    expect((await hook(call('memory_write', { query: 'a' }, 't1'))).error).toMatch(/one call/);
    expect((await hook(call('web_search', { query: 'b' }, 't1'))).error).toMatch(/one call/);
  });

  it('the re-judge fire of the spent call (after an argument rewrite) is still allowed', async () => {
    const { hook } = gated('m-yes');
    const original = { query: 'Alice' };
    expect(await hook(call('web_search', original, 't1'))).toEqual({});
    expect(
      await hook({
        ...call('web_search', { query: 'Alice (rewritten)' }, 't1'),
        rewrittenFrom: original,
      }),
    ).toEqual({});
  });

  it('a new yes on a later turn re-arms exactly one call', async () => {
    const { sessions, hook } = gated('m-yes');
    expect(await hook(call('web_search', {}, 't1'))).toEqual({});
    sessions.gate('s1', 'm-yes-2');
    expect(await hook(call('memory_write', { store: 'user' }, 't2'))).toEqual({});
    expect((await hook(call('memory_write', { store: 'user' }, 't3'))).error).toMatch(/one call/);
    sessions.gate('s1', undefined);
    expect((await hook(call('web_search', {}, 't4'))).error).toMatch(/consent/);
  });

  it('an unknown (evicted) session with an opted-in personality falls back to gated', async () => {
    const sessions = new FirstContactSessions();
    const hook = createConsentRequiredToolsHook(sessions, { personalities: registry() });
    expect((await hook(call('web_search', {}, 't1', 'friend'))).error).toMatch(/consent/);
    expect(await hook(call('memory_read', {}, 't1', 'friend'))).toEqual({});
    // A personality that never opted in keeps its tools.
    expect(await hook(call('web_search', {}, 't1', 'plain'))).toEqual({});
  });

  it('evicting past the bound does not open an in-flight gated session', async () => {
    const sessions = new FirstContactSessions();
    const injector = createFirstContactInjector({
      memory: memory(),
      personalities: registry(),
      sessions,
    });
    const hook = createConsentRequiredToolsHook(sessions, { personalities: registry() });
    await injector.inject(promptCtx());
    expect(sessions.get('s1')?.gated).toBe(true);
    for (let i = 0; i < 1100; i++) sessions.clear(`other-${i}`);
    expect(sessions.get('s1')).toBeUndefined();
    expect((await hook(call('web_search', {}, 't1', 'friend'))).error).toMatch(/consent/);
  });
});

// ---------------------------------------------------------------------------
// Through a real AgentLoop
// ---------------------------------------------------------------------------

type Step = Array<{ id: string; name: string; input: unknown }> | string;

/** Plays one step per `complete()` call: a tool batch, or final text. */
function scriptedLLM(steps: Step[], systems: string[]): LLMProvider {
  let i = 0;
  return {
    name: 'scripted',
    model: 'mock-model',
    maxContextTokens: 200_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(
      _m: unknown,
      _t: unknown,
      opts: CompletionOptions,
    ): AsyncIterable<CompletionChunk> {
      systems.push(typeof opts.system === 'string' ? opts.system : JSON.stringify(opts.system));
      const step = steps[i++] ?? 'done';
      if (typeof step === 'string') {
        yield { type: 'text_delta', text: step };
        yield { type: 'done', finishReason: 'end_turn' };
        return;
      }
      for (const c of step) {
        yield { type: 'tool_use_start', toolCallId: c.id, toolName: c.name };
        yield { type: 'tool_use_end', toolCallId: c.id, inputJson: JSON.stringify(c.input) };
      }
      yield { type: 'done', finishReason: 'tool_use' };
    },
    async countTokens() {
      return 1;
    },
  };
}

async function drain(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

function harness(steps: Step[]) {
  const storage = new InMemoryStorage();
  const mem = memory(storage);
  const session = new InMemorySessionStore();
  const hooks = new DefaultHookRegistry();
  const tools = new DefaultToolRegistry();
  const searched = vi.fn(async (): Promise<ToolResult> => ({ ok: true, value: 'Alice is a chef' }));
  tools.register({
    name: 'web_search',
    description: 'search the web',
    schema: { type: 'object' },
    capabilities: {},
    execute: searched,
  });
  for (const t of createMemoryTools(mem, session)) tools.register(t);
  const injector = composeFirstContact({ memory: mem, personalities: registry(), hooks });
  const systems: string[] = [];
  const loop = new AgentLoop({
    llm: scriptedLLM(steps, systems),
    tools,
    hooks,
    session,
    memory: mem,
    personalities: registry(),
    injectors: [injector],
    safety: createTestSafety(),
  });
  const run = (text: string) =>
    drain(
      loop.run(text, {
        sessionKey: 'telegram:bot:alice',
        personalityId: 'friend',
        userId: USER_ID,
        roomAudience: 'private',
      }),
    );
  return { run, mem, session, searched, systems, tools };
}

const SEARCH = { id: 'c1', name: 'web_search', input: { query: 'Alice' } };
const WRITE = {
  id: 'c2',
  name: 'memory_write',
  input: { store: 'user', action: 'add', content: 'Alice is a chef.' },
};

describe('first contact through the agent loop', () => {
  it('refuses a lookup before a yes (persisted as an error tool_result, never executed), runs it after', async () => {
    const h = harness([
      [{ ...SEARCH, id: 'c0' }],
      'May I look up your name online?',
      [SEARCH],
      // Same turn: the yes was spent on the lookup, so this write is refused.
      [{ ...WRITE, id: 'c2-early' }],
      'Found you. May I remember that you are a chef?',
      [WRITE],
      'Noted.',
    ]);

    const first = await h.run('hi, I am Alice');
    expect(h.searched).not.toHaveBeenCalled();
    const refused = first.find((e) => e.type === 'tool_end' && e.toolCallId === 'c0');
    expect(refused).toMatchObject({ ok: false });
    const stored = await h.session.getSessionByKey('telegram:bot:alice');
    const all = await h.session.getMessages(stored?.id ?? '', { limit: 100 });
    const errorResult = all.find((m) => m.role === 'tool_result' && m.toolCallId === 'c0');
    expect(errorResult?.content).toMatch(/consent/);
    // The first-contact line reached the prompt, in the tail.
    expect(h.systems[0]).toContain(GET_TO_KNOW_YOU_SKILL);

    await h.run('yes');
    expect(h.searched).toHaveBeenCalledTimes(1);
    expect(await h.mem.read('USER.md', userCtx())).toBeNull();

    await h.run('yes please');
    const written = await h.mem.read('USER.md', userCtx());
    expect(written?.content).toContain('Alice is a chef.');
  });

  it('one yes buys one call even when every step reuses the id text-tool-0', async () => {
    const reused = { ...SEARCH, id: 'text-tool-0' };
    const h = harness(['May I look up your name online?', [reused], [reused], [reused], 'ok']);
    await h.run('hi, I am Alice');
    await h.run('yes');
    expect(h.searched).toHaveBeenCalledTimes(1);
  });

  it('refuses delegate_task while first contact is on, even after a yes', async () => {
    const h = harness([
      'May I look you up?',
      [{ id: 'd1', name: 'delegate_task', input: { goal: 'research Alice online' } }],
      'ok',
    ]);
    const delegated = vi.fn(async (): Promise<ToolResult> => ({ ok: true, value: 'done' }));
    h.tools.register({
      name: 'delegate_task',
      description: 'delegate',
      schema: { type: 'object' },
      capabilities: {},
      execute: delegated,
    });
    await h.run('hi');
    const events = await h.run('yes');
    expect(delegated).not.toHaveBeenCalled();
    expect(events.find((e) => e.type === 'tool_end' && e.toolCallId === 'd1')).toMatchObject({
      ok: false,
    });
  });

  it('a bare yes with no consent question before it runs nothing', async () => {
    const h = harness(['Hi! What can I help with?', [SEARCH], 'ok']);
    await h.run('hi');
    await h.run('yes');
    expect(h.searched).not.toHaveBeenCalled();
  });

  it('writes nothing when the user declines, to any store', async () => {
    const h = harness([
      'May I note that you are a chef?',
      [WRITE, { id: 'c3', name: 'memory_write', input: { ...WRITE.input, store: 'memory' } }],
      'Understood.',
    ]);
    await h.run('hi');
    await h.run('no');
    expect(await h.mem.read('USER.md', userCtx())).toBeNull();
    expect(
      await h.mem.read('MEMORY.md', { ...userCtx(), scopeId: 'personality:friend' }),
    ).toBeNull();
    expect(h.searched).not.toHaveBeenCalled();
  });
});
