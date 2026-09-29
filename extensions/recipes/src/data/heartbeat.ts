// Heartbeat — a personality-owned periodic check-in (plan
// personality-presence-and-initiative §6, after OpenClaw's heartbeat
// activeHours).
//
// Attach-only: a check-in belongs to a personality the user already talks to,
// so the recipe adds a SOUL section and a schedule to it rather than creating a
// new agent.
//
// Two gates keep it cheap and quiet, and neither is new here:
//
//  * `activeHours` is on by default. Outside 09:00-21:00 the scheduler skips
//    the occurrence BEFORE the turn — zero LLM calls, audited as
//    'inactive-hours-skip' (`CronScheduler.tick`, extensions/cron/src/index.ts).
//    It is read on the server's clock, the one croner reads the schedule on
//    (`CronScheduler.outsideActiveHours`), not `notifications.timezone`.
//    `CronScheduler.createJob` refuses a malformed window at install.
//  * A run with nothing worth saying begins its reply with `[SILENT]`, which
//    `decideEscalation` (extensions/cron/src/heartbeat.ts) persists and audits
//    but never delivers. There is no second silence rule.

import type { RecipeAttachBundle } from '../schema';

const TOOLS = ['memory_read', 'session_search', 'todo_list'];

const SOUL_SECTION = `## Check-ins

A few times a day I check in on my own. I read what I know — memory_read for MEMORY.md
and USER.md, session_search for what we talked about recently, todo_list for open items —
and I speak only when I have something worth the interruption: a deadline that is close,
an open item that has gone quiet, a follow-up I promised. One or two short sentences, never
a status report. When there is nothing worth saying, I begin my reply with [SILENT] and
stop — a check-in that says "nothing new" is noise.
`;

export const heartbeat: RecipeAttachBundle = {
  id: 'heartbeat',
  version: 1,
  title: 'Heartbeat check-in',
  summary:
    'An agent you already have checks in on its own a few times a day, during waking hours only, and stays silent when there is nothing worth saying.',
  tags: ['scheduled', 'attach', 'no-credentials'],

  personality: {
    mode: 'attach',
    soulSection: SOUL_SECTION,
    toolset: TOOLS,
    mcpServers: [],
    plugins: [],
  },

  requires: {
    mcpServers: [],
    plugins: [],
    channels: [],
    tools: TOOLS,
    inputs: [
      {
        key: 'checkInSchedule',
        label: 'Check-in schedule',
        kind: 'cron',
        required: true,
        default: '0 */3 * * *',
        help: "Cron expression, on the server's clock. '0 */3 * * *' is every three hours; with the 09:00-21:00 active hours (end exclusive) that is 09:00, 12:00, 15:00 and 18:00, and the 21:00 and night-time occurrences are skipped without a turn.",
      },
    ],
  },

  cronJobs: [
    {
      name: 'heartbeat',
      schedule: '{{input.checkInSchedule}}',
      prompt:
        'Check in. Read memory and recent conversations, and look at open todos. If something is worth raising now — a close deadline, an item that has gone quiet, a follow-up you promised — say it in one or two sentences. If nothing is, begin your reply with [SILENT] and say nothing else.',
      missedRunPolicy: 'skip',
      activeHours: '09:00-21:00',
      deliverTo: 'inApp',
    },
  ],

  starterPrompt: 'What would make a check-in from you worth reading?',
  examplePrompts: [
    'Only check in about work items, never personal ones.',
    'Remind me about anything due within two days.',
  ],

  notes: [
    'Active hours are 09:00-21:00 by default, on the server’s clock — the same clock the schedule runs on, so the two always agree (`notifications.timezone` moves quiet hours only). Outside them the check-in is skipped before any model call, so a night-time occurrence costs nothing. Change or remove the window with the cron tool (`active_hours`, or `off`) or `ethos cron update <id> --active-hours`.',
    'Active hours save the turn; quiet hours still guard delivery. A check-in inside its window that lands in quiet hours or a `/mute` on a channel is held, not dropped.',
    'A check-in with nothing to say begins with [SILENT]: it is kept in the run history and audited, but never delivered.',
    'Check-ins land in the web notifications feed. Cost is one short turn per check-in, four a day with the defaults.',
  ],

  postInstall: [],
};
