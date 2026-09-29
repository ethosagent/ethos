// First contact — getting to know the user, with consent (plan
// personality-presence-and-initiative §7).
//
// Two pieces share one per-session gate:
//
// - `createFirstContactInjector` adds ONE line to the prompt tail when this
//   turn is private, the sender's `user:<id>` USER.md is empty or absent, and
//   the turn's personality lists the bundled `get-to-know-you` skill. The same
//   pass opens the session's gate, and records whether the user's message THIS
//   turn is consent (`consentYesId`).
// - `createConsentRequiredToolsHook` is a `before_tool_call` refusal. While the
//   gate is open for a session:
//     * a tool on `FIRST_CONTACT_ALLOWED_TOOLS` runs;
//     * a tool on `FIRST_CONTACT_REFUSED_TOOLS` is refused, yes or no — the
//       work it starts runs in another session, loop or time, where this gate
//       cannot count it (a `delegate_task` child runs under a `:sub:` session
//       with no userId, so no first-contact state reaches it);
//     * EVERY other tool — lookups, terminal, run_code, browser, MCP, every
//       memory write — needs consent, and one consent allows ONE such call.
//       Once the yes is spent, every later consent-required call in the turn
//       is refused unless it is the SAME call fired again in the same step (the
//       loop's re-judge fire after an argument rewrite). "Same call" is the
//       tool-call id AND tool name AND a hash of the args it was proposed with
//       (`callFingerprint`); an empty id never matches, and once the spent
//       call's `after_tool_call` fires (`createSpentCallCloser`) its step is
//       over and nothing matches it any more. The id alone is not enough: the
//       text-xml transport restarts `text-tool-N` on every `complete()` call
//       (`streamTextToolCalls`, extensions/llm-openai-compat/src/text-tool-call-transport.ts)
//       and a native transport can yield `''`. Pinned by the 'text-tool-0'
//       and 'empty call id' cases in `__tests__/first-contact.test.ts`.
//   The loop persists a refusal as an error tool_result and never executes the
//   call (`enforceBeforeToolCall`, packages/core/src/agent-loop/stages/per-call-enforcement.ts;
//   pinned by `__tests__/first-contact.test.ts`).
//
// How long the gate lasts: once the injector opens it for a session, it stays
// open for that session (until `/new` starts a fresh one), even after USER.md
// gains its first line — the getting-to-know-you conversation is not over when
// the first fact lands. The line itself is shown only while USER.md is empty.
// Limitation: the gate lives in this process's memory. A restart, or eviction
// past `MAX_SESSIONS`, forgets it; the next turn re-derives it from USER.md,
// so a session whose USER.md already has content is then no longer gated. A
// turn in flight is never opened by an eviction: an unknown session whose
// personality opted in is treated as gated (see the hook).
//
// How consent is detected: the injector runs once per turn in context
// assembly, after this turn's user message is persisted and loaded into
// `PromptContext.history`, and before any tool runs. The latest `user` row is
// consent only when BOTH hold:
//   1. it is a bare affirmative (`isExplicitYes`: "yes", "sure", "go ahead";
//      NOT "ok"/"okay", which people say to acknowledge, not to agree), and
//   2. the last assistant row before it asked a consent question
//      (`askedForConsent`: a sentence starting "May I …" or "Can I" + look /
//      search / check / find / save / remember / note / store / read, and
//      ending in "?" — the skill requires "May I …?" for every lookup and
//      save; "Can I help you with anything else?" is not a consent question).
// A false negative costs the model one more question; a false positive needs
// the model to have asked and the user to have answered with a bare yes. What
// it cannot know is WHICH question the yes answered; the skill asks one
// question per call, and the hook allows one call per yes, which bounds a
// misread yes to the one call it was asked about.
//
// Only the user's own message counts. A yes typed as a `clarify` answer does
// NOT arm consent: that answer comes back as the clarify tool's result inside
// the running turn, never as a `user` row in `PromptContext.history`, and the
// injector reads the history once per turn before any tool runs. The model has
// to ask "May I …?" as the last thing in its reply and wait for the next turn.
//
// No code path here writes USER.md. A hook cannot ask for consent; only the
// conversation can.

import { createHash } from 'node:crypto';
import type {
  AfterToolCallPayload,
  BeforeToolCallPayload,
  BeforeToolCallResult,
  ContextInjector,
  HookRegistry,
  InjectionResult,
  MemoryProvider,
  PersonalityConfig,
  PersonalityRegistry,
  PromptContext,
  StoredMessage,
} from '@ethosagent/types';

/** Qualified name of the bundled skill (`skills/personal/get-to-know-you`,
 *  advertised in `BUNDLED_SKILL_IDS`, extensions/skills/src/bundled.ts). A
 *  personality opts in by listing it in `skills.global_ingest.allow`. */
export const GET_TO_KNOW_YOU_SKILL = 'ethos-bundled/personal/get-to-know-you';

/**
 * The only tools that run without consent while the gate is open. Each one
 * reads nothing outside this session, this user's own profile, or the skill
 * pool, and sends nothing anywhere:
 *
 * - `memory_read` — reads this personality's MEMORY.md and this user's own
 *   USER.md (`createMemoryReadTool`, extensions/tools-memory); a read, never a
 *   lookup, and how the model avoids asking twice.
 * - `session_search` — full-text search bound to `ctx.sessionId`
 *   (`createSessionSearchTool`, extensions/tools-memory/src/index.ts), so it
 *   reads only the conversation already in front of the model.
 * - `get_skill`, `skills_list`, `skill_view` — read skill bodies from the
 *   skill pool (`GetSkillTool`, extensions/skills; `createSkillsTools`,
 *   extensions/tools-skills). The first-contact line tells the model to load
 *   the skill with `get_skill`, so refusing it would block the skill itself.
 * - `clarify` — asks the user a question and waits (`createClarifyTool`,
 *   extensions/tools-interactive); asking is what consent is made of.
 */
export const FIRST_CONTACT_ALLOWED_TOOLS: readonly string[] = [
  'memory_read',
  'session_search',
  'get_skill',
  'skills_list',
  'skill_view',
  'clarify',
];

/**
 * Refused outright while the gate is open, even after a yes: each one's work
 * outlives this turn, reaches people other than this user, or is handed to
 * another agent — where the one-call-per-yes count cannot follow it, and where
 * a yes to "May I look up …?" was never a yes to it.
 *
 * - Another agent or peer runs it: tools-delegation (`delegate_task`,
 *   `mixture_of_agents`, `route_to_agent`, `dispatch_team`,
 *   `broadcast_to_agents`), tools-a2a (`a2a_send`).
 * - It runs later, on a schedule or in the background: tools-cron (`cron`),
 *   tools-watchers (`watcher_create`, and `watcher_resume`, which re-arms a
 *   paused watcher's schedule), tools-goals (`goal_create`), tools-process
 *   (`process_start`, a long-running background process).
 * - It hands a ticket to the kanban dispatcher, which runs it under another
 *   assignee: tools-kanban (`kanban_create`, `kanban_create_goal`,
 *   `kanban_create_swarm`, `kanban_decompose`, `kanban_assign`,
 *   `kanban_update_status`, `kanban_unblock`, and `kanban_complete`, which
 *   runs the completion verifier and releases dependent tickets).
 * - It reaches third parties: tools-messaging (`send_message` to another
 *   channel), tools-voice (`call` dials a phone number; `voice_session` names
 *   a live voice session the channel runs — a no-op marker today, refused so
 *   the name never becomes a way around this list), tools-meeting
 *   (`meet_join` joins a real meeting and captures it past this reply).
 *
 * Stopping or reading such work (`watcher_pause`, `process_stop`,
 * `task_status`, `kanban_show`) is not here; it stays consent-gated like any
 * other tool.
 */
export const FIRST_CONTACT_REFUSED_TOOLS: readonly string[] = [
  'delegate_task',
  'mixture_of_agents',
  'route_to_agent',
  'dispatch_team',
  'broadcast_to_agents',
  'a2a_send',
  'cron',
  'watcher_create',
  'goal_create',
  'kanban_create',
  'kanban_create_goal',
  'kanban_create_swarm',
  'kanban_decompose',
  'kanban_assign',
  'kanban_update_status',
  'kanban_unblock',
  'kanban_complete',
  'process_start',
  'watcher_resume',
  'send_message',
  'call',
  'voice_session',
  'meet_join',
];

/** One line, byte-identical on every turn it appears (prefix-cache safe). */
const FIRST_CONTACT_LINE = `First contact: you know nothing about this person yet. After helping with what they asked, you may offer once to get to know them — load the \`${GET_TO_KNOW_YOU_SKILL}\` skill with get_skill first, ask before every lookup, and save nothing without their yes.`;

/**
 * Below every other built-in injector (the lowest today is 30), so the line
 * lands after the static injectors and just before the memory tail. It
 * appears and disappears with USER.md, which changes the memory tail at the
 * same moment anyway.
 */
const FIRST_CONTACT_PRIORITY = 20;

/** Bound on remembered sessions; the least recently seen is dropped first. */
const MAX_SESSIONS = 1024;

const LEAD = 'yes|yeah|yep|yup|sure|go ahead|please do|do it|of course|absolutely|sounds good';
const FOLLOW = `${LEAD}|please|thanks|thank you`;
const EXPLICIT_YES = new RegExp(`^(?:${LEAD})(?:[\\s,]+(?:${FOLLOW}))*[\\s.!]*$`, 'i');

/**
 * A sentence that STARTS (after optional markdown emphasis or a quote) with
 * "May I", or with "Can I" plus a verb that does something about the user
 * (look, search, check, find, save, remember, note, store, read), and ends in
 * "?". "What can I help with?" and "Can I help you with anything else?" are
 * offers, not consent questions.
 */
const CONSENT_QUESTION =
  /(?:^|[.!?:]\s+|\n)[\s*_"'>(]*(?:may I\b|can I\s+(?:look|search|check|find|save|remember|note|store|read)\b)[^?.!\n]*\?/i;

/**
 * True when the message is nothing but an affirmative. Only the last paragraph
 * is read: the loop prefixes attachment and voice annotations to the persisted
 * user text with a blank line (`assembleContext`), and the words the user
 * actually said come last.
 */
export function isExplicitYes(text: string): boolean {
  const paragraphs = text.split(/\n\s*\n/);
  const last = (paragraphs[paragraphs.length - 1] ?? '').trim();
  return last.length > 0 && EXPLICIT_YES.test(last);
}

/** True when an assistant message asks a consent question ("May I look up …?"). */
export function askedForConsent(text: string): boolean {
  return CONSENT_QUESTION.test(text);
}

/**
 * Id of the latest user message when it is consent: a bare yes answering a
 * consent question in the assistant message right before it. Otherwise
 * undefined.
 */
function consentYesId(history: readonly StoredMessage[]): string | undefined {
  let userIndex = -1;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i]?.role === 'user') {
      userIndex = i;
      break;
    }
  }
  const latestUser = history[userIndex];
  if (!latestUser || !isExplicitYes(latestUser.content)) return undefined;
  for (let i = userIndex - 1; i >= 0; i--) {
    const m = history[i];
    if (m?.role === 'user') return undefined;
    if (m?.role === 'assistant') return askedForConsent(m.content) ? latestUser.id : undefined;
  }
  return undefined;
}

interface FirstContactState {
  /** First contact started in this session; stays true for its lifetime. */
  gated: boolean;
  /** Id of this turn's user message when it is consent. */
  yesMessageId: string | undefined;
  /** The one consent-required call this turn's yes was spent on. */
  spent: SpentCall | undefined;
}

interface SpentCall {
  /** `callFingerprint` of the call as first proposed; undefined (matches
   *  nothing) when its id was empty. */
  fingerprint: string | undefined;
  toolCallId: string;
  toolName: string;
  /** Set once the call's `after_tool_call` fired: its step is over. */
  closed: boolean;
}

/**
 * Identity of one proposed call: id, tool name and a hash of the args. An
 * empty id yields `undefined`, which never matches anything.
 */
function callFingerprint(toolCallId: string, toolName: string, args: unknown): string | undefined {
  if (toolCallId === '') return undefined;
  let json: string;
  try {
    json = JSON.stringify(args) ?? 'undefined';
  } catch {
    return undefined;
  }
  const argsHash = createHash('sha256').update(json).digest('hex');
  return `${toolCallId}\u0000${toolName}\u0000${argsHash}`;
}

/** Per-session gate, written by the injector, read by the hook. */
export class FirstContactSessions {
  private readonly bySession = new Map<string, FirstContactState>();

  /** Open (or keep open) the gate; `yesMessageId` re-arms one call per turn. */
  gate(sessionId: string, yesMessageId: string | undefined): void {
    this.put(sessionId, { gated: true, yesMessageId, spent: undefined });
  }

  /** Record that this session is not gated. Never closes an open gate. */
  clear(sessionId: string): void {
    if (this.bySession.get(sessionId)?.gated) return;
    this.put(sessionId, { gated: false, yesMessageId: undefined, spent: undefined });
  }

  /** Mark the spent call's step over. Keyed on id and name, not args: the
   *  args `after_tool_call` reports are the post-rewrite ones. */
  closeSpent(sessionId: string, toolCallId: string, toolName: string): void {
    const spent = this.bySession.get(sessionId)?.spent;
    if (spent && spent.toolCallId === toolCallId && spent.toolName === toolName) {
      spent.closed = true;
    }
  }

  get(sessionId: string): FirstContactState | undefined {
    return this.bySession.get(sessionId);
  }

  isGated(sessionId: string): boolean {
    return this.bySession.get(sessionId)?.gated === true;
  }

  private put(sessionId: string, state: FirstContactState): void {
    // Delete-then-set keeps Map order least-recently-seen first.
    this.bySession.delete(sessionId);
    this.bySession.set(sessionId, state);
    if (this.bySession.size > MAX_SESSIONS) {
      const oldest = this.bySession.keys().next().value;
      if (oldest !== undefined) this.bySession.delete(oldest);
    }
  }
}

function listsSkill(personality: PersonalityConfig | undefined): boolean {
  const ingest = personality?.skills?.global_ingest;
  if (!ingest?.allow?.includes(GET_TO_KNOW_YOU_SKILL)) return false;
  // Deny wins over allow, as it does in the skill filter (`filterSkill`,
  // extensions/skills/src/ingest-filter.ts).
  return !ingest.deny?.includes(GET_TO_KNOW_YOU_SKILL);
}

export function createFirstContactInjector(opts: {
  memory: MemoryProvider;
  personalities: Pick<PersonalityRegistry, 'get'>;
  sessions: FirstContactSessions;
}): ContextInjector {
  const { memory, personalities, sessions } = opts;
  return {
    id: 'first-contact',
    priority: FIRST_CONTACT_PRIORITY,
    async inject(ctx: PromptContext): Promise<InjectionResult | null> {
      const started = sessions.isGated(ctx.sessionId);
      const yes = consentYesId(ctx.history);
      // An open gate stays open; each turn only re-arms (or disarms) its yes.
      if (started) sessions.gate(ctx.sessionId, yes);

      // `isDm` is `roomAudience !== 'shared'` (assembleContext), i.e. private.
      if (
        !ctx.isDm ||
        ctx.userId === undefined ||
        ctx.personalityId === undefined ||
        !listsSkill(personalities.get(ctx.personalityId))
      ) {
        sessions.clear(ctx.sessionId);
        return null;
      }

      let empty: boolean;
      try {
        const profile = await memory.read('USER.md', {
          scopeId: `user:${ctx.userId}`,
          sessionId: ctx.sessionId,
          sessionKey: ctx.sessionKey,
          platform: ctx.platform,
          workingDir: ctx.workingDir ?? '',
        });
        empty = !profile?.content.trim();
      } catch {
        // Fail CLOSED: an unreadable profile could be an empty one, so the
        // session is gated, and the turn goes on without the line rather than
        // failing. Pinned by 'fails CLOSED when the profile read throws'.
        sessions.gate(ctx.sessionId, yes);
        return null;
      }
      if (!empty) {
        sessions.clear(ctx.sessionId);
        return null;
      }
      sessions.gate(ctx.sessionId, yes);
      return { content: FIRST_CONTACT_LINE, position: 'append' };
    },
  };
}

export function createConsentRequiredToolsHook(
  sessions: FirstContactSessions,
  opts: { personalities?: Pick<PersonalityRegistry, 'get'> } = {},
): (payload: BeforeToolCallPayload) => Promise<BeforeToolCallResult> {
  const allowed = new Set(FIRST_CONTACT_ALLOWED_TOOLS);
  const refused = new Set(FIRST_CONTACT_REFUSED_TOOLS);
  return async (payload) => {
    let state = sessions.get(payload.sessionId);
    if (state === undefined) {
      // Unknown session: the injector runs every turn, so this is a session
      // evicted mid-turn (or never assembled). Fail closed for a personality
      // that opted in; a gate with no yes lets only the allowlist through.
      const personality = payload.personalityId
        ? opts.personalities?.get(payload.personalityId)
        : undefined;
      if (!listsSkill(personality)) return {};
      state = { gated: true, yesMessageId: undefined, spent: undefined };
    }
    if (!state.gated || allowed.has(payload.toolName)) return {};

    if (refused.has(payload.toolName)) {
      return {
        error: `first-contact consent: ${payload.toolName} is not available while you are getting to know this user — the work it starts runs outside this conversation, where their consent cannot follow it. Do it yourself, one step at a time, asking before each step.`,
      };
    }
    if (state.yesMessageId === undefined) {
      return {
        error: `first-contact consent: ${payload.toolName} needs the user's explicit yes. Ask one question ("May I look up …?" or "May I remember …?") and wait for their reply. If they say no, drop it.`,
      };
    }
    // The loop fires this hook twice for one call after an argument rewrite;
    // the re-judge fire carries the proposed args in `rewrittenFrom`, so both
    // fires share one fingerprint. Anything else after the spend is refused.
    const proposed = payload.rewrittenFrom !== undefined ? payload.rewrittenFrom : payload.args;
    const fingerprint = callFingerprint(payload.toolCallId, payload.toolName, proposed);
    if (state.spent !== undefined) {
      const same = fingerprint !== undefined && state.spent.fingerprint === fingerprint;
      if (same && !state.spent.closed) {
        return {};
      }
      return {
        error: `first-contact consent: the user's yes allows one call, and it was used. Ask again ("May I …?") before ${payload.toolName}.`,
      };
    }
    state.spent = {
      fingerprint,
      toolCallId: payload.toolCallId,
      toolName: payload.toolName,
      closed: false,
    };
    return {};
  };
}

/**
 * `after_tool_call` handler: the spent call has run (or been refused), so its
 * step is over and a later call with the same id, name and args — the
 * text-xml transport's `text-tool-0` on the next step — is a new call.
 */
export function createSpentCallCloser(
  sessions: FirstContactSessions,
): (payload: AfterToolCallPayload) => Promise<void> {
  return async (payload) => {
    sessions.closeSpent(payload.sessionId, payload.toolCallId, payload.toolName);
  };
}

/**
 * Register the consent hook and return the injector to add to the loop's list.
 * The hook is built-in (no `pluginId`), so no plugin allowlist can skip it.
 */
export function composeFirstContact(opts: {
  memory: MemoryProvider;
  personalities: Pick<PersonalityRegistry, 'get'>;
  hooks: HookRegistry;
}): ContextInjector {
  const sessions = new FirstContactSessions();
  opts.hooks.registerModifying(
    'before_tool_call',
    createConsentRequiredToolsHook(sessions, { personalities: opts.personalities }),
  );
  opts.hooks.registerVoid('after_tool_call', createSpentCallCloser(sessions));
  return createFirstContactInjector({ ...opts, sessions });
}
