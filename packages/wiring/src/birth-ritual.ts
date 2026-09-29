// The birth ritual (plan personality-presence-and-initiative §1).
//
// A personality the operator creates is born with a marker
// (`learning/birth/<id>.json`, written by `FilePersonalityRegistry.create`,
// extensions/personalities/src/birth.ts). While that marker exists, this
// injector adds ONE tail section to the personality's private, person-started
// CLI and web turns: answer what the operator actually asked first, then run
// the ritual — confirm or change the name the operator gave it at create time
// (every create path asks for one), propose a one-line vibe and an emoji the
// operator can veto, keep the current avatar unless they want to upload one —
// and file the result with `propose_self_amendment` target `identity`. The
// steps live in the bundled `birth-ritual` skill (`skills/personal/birth-ritual`).
//
// It is silent unless every one of these holds, checked in this order:
// - `gateRefusal(ctx) === null` (./amendments.ts) — the same gate the filing
//   passes: a person started the turn, in a private room, on the owner's CLI
//   or web app, not a job, a review turn, a sub-agent or a dry run. So a
//   Telegram DM, a shared room or a cron turn never sees the ritual, and the
//   ritual is never offered where it could not be filed;
// - the personality is user-owned (`isUserOwned`, ./amendments.ts) — a
//   built-in is refused by the intake, so a marker planted for its id is
//   ignored;
// - its toolset lists `propose_self_amendment` — the intake's opt-in (check 3);
// - the marker exists (`hasBirthMarker`);
// - no identity amendment for it is `pending` (the ritual is done filing and
//   waits for the owner, instead of starting again every turn) or `applied`
//   (the ritual is over, even if clearing the marker after the apply crashed
//   or threw — `clearBirthOnIdentity`, ./amendments.ts). Only records filed at
//   or after the marker's `createdAt` count (`birthMarkerCreatedAt`,
//   extensions/personalities/src/birth.ts): a record left by an earlier
//   personality with the same id — deleted without `retireDeletedPersonality`,
//   ./amendments.ts — belongs to that one's life, not this one's. A marker
//   with no readable `createdAt` counts every record, as before;
// - `taintRefusal(ctx) === null` (./amendments.ts) — the intake's check 2,
//   the same function over the same stored session (last, because it reads
//   the whole session): once a turn has seen untrusted content (a
//   `web_fetch` result, an attachment), the filing the ritual ends in would
//   be refused, so it is not offered — and not re-offered on every later
//   turn of that session.
//
// Nothing here writes. Applying the identity amendment clears the marker
// (`createAmendmentService`, ./amendments.ts); so does
// `ethos personality birth skip <id>`.
//
// The section is an `append`: it lands in the prompt tail, never in the static
// prefix, and it is byte-identical on every turn it appears
// (packages/core/src/__tests__/prompt-prefix-stability.test.ts). Pinned by
// packages/wiring/src/__tests__/birth-ritual.test.ts.

import { listAmendments } from '@ethosagent/learning-inbox';
import { birthMarkerCreatedAt, hasBirthMarker } from '@ethosagent/personalities';
import { PROPOSE_SELF_AMENDMENT_TOOL } from '@ethosagent/tools-personality-design';
import type {
  ContextInjector,
  InjectionResult,
  PersonalityRegistry,
  PromptContext,
  Storage,
} from '@ethosagent/types';
import { type AmendmentIntakeDeps, gateRefusal, isUserOwned, taintRefusal } from './amendments';

/** Qualified name of the bundled skill (`skills/personal/birth-ritual`,
 *  advertised in `BUNDLED_SKILL_IDS`, extensions/skills/src/bundled.ts). It
 *  requires `propose_self_amendment`, so the capability filter shows it to a
 *  personality that holds that tool (`filterSkill`,
 *  extensions/skills/src/ingest-filter.ts). */
export const BIRTH_RITUAL_SKILL = 'ethos-bundled/personal/birth-ritual';

/** One section, byte-identical on every turn it appears (prefix-cache safe). */
const BIRTH_RITUAL_SECTION = [
  '## Your birth',
  '',
  'Your operator just created you and gave you the name you have now. This conversation is your birth.',
  '',
  `1. First, answer the operator's actual message in full, as you would any request. Never make them wait on the ritual.`,
  `2. Then start your birth ritual: load the \`${BIRTH_RITUAL_SKILL}\` skill with get_skill and follow it, one question per reply.`,
  '   - Ask them to confirm or change your name. Never pick a new one yourself.',
  '   - Propose a one-line vibe and one emoji; they can veto or change either.',
  '   - Keep your current avatar by default; they can upload a new image after they approve.',
  `3. When they have agreed, file it with \`${PROPOSE_SELF_AMENDMENT_TOOL}\` (target "identity"). Nothing changes until they apply it.`,
].join('\n');

/**
 * Below every other built-in injector (the lowest static one is 30), beside
 * first contact (20, ./first-contact.ts), so the section lands after the static
 * injectors and just before the memory tail.
 */
const BIRTH_RITUAL_PRIORITY = 25;

export function createBirthRitualInjector(opts: {
  /** Compose-time, unscoped: the marker and the amendment store live under
   *  `learning/`, which every turn's ScopedStorage denies. */
  storage: Storage;
  dataDir: string;
  personalities: Pick<PersonalityRegistry, 'get'>;
  /** The loop's own session store and tool registry — what `taintRefusal` reads. */
  sessions: AmendmentIntakeDeps['sessions'];
  tools: AmendmentIntakeDeps['tools'];
}): ContextInjector {
  const { storage, dataDir, personalities } = opts;
  return {
    id: 'birth-ritual',
    priority: BIRTH_RITUAL_PRIORITY,
    async inject(ctx: PromptContext): Promise<InjectionResult | null> {
      if (gateRefusal(ctx) !== null || ctx.personalityId === undefined) return null;
      const personality = personalities.get(ctx.personalityId);
      if (!personality || !isUserOwned(personality, dataDir)) return null;
      if (!personality.toolset?.includes(PROPOSE_SELF_AMENDMENT_TOOL)) return null;
      if (!(await hasBirthMarker(storage, dataDir, ctx.personalityId))) return null;
      const bornAt = await birthMarkerCreatedAt(storage, dataDir, ctx.personalityId);
      const records = await listAmendments(storage, dataDir, { personalityId: ctx.personalityId });
      const settled = records.some(
        (record) =>
          record.target === 'identity' &&
          (record.status === 'pending' || record.status === 'applied') &&
          (bornAt === null || !(Date.parse(record.createdAt) < bornAt)),
      );
      if (settled) return null;
      // Last: it reads the whole stored session.
      if ((await taintRefusal(opts, ctx)) !== null) return null;
      return { content: BIRTH_RITUAL_SECTION, position: 'append' };
    },
  };
}
