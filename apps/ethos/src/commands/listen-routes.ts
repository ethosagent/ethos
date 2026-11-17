// `ethos listen` — the wake route table and VAD tuning as this host reads them from
// config, and the `--route` pin resolved against what the server pushed. Split
// out of listen.ts.

import type { WakeRouteConfig } from '@ethosagent/config';
import type { WakeRoute } from '@ethosagent/voice-satellite';
import type { ListenPreflight } from './listen-preflight';

/**
 * `voice.bargeIn.satellite` as `EnergyVad` wants it — or nothing at all.
 *
 * Returns undefined rather than an empty object when the operator tuned neither
 * field, so the preflight carries no key and the daemon hands the detector no
 * config: "not tuned" and "tuned to the default" stay distinguishable all the
 * way down.
 */
export function readSatelliteVadTuning(
  tuning: { energyThreshold?: number; minSpeechMs?: number } | undefined,
): ListenPreflight['vadTuning'] {
  if (tuning?.energyThreshold === undefined && tuning?.minSpeechMs === undefined) return undefined;
  return {
    ...(tuning.energyThreshold === undefined ? {} : { threshold: tuning.energyThreshold }),
    ...(tuning.minSpeechMs === undefined ? {} : { minSpeechMs: tuning.minSpeechMs }),
  };
}

/** `voice.wake.routes` as the wake seam wants them: disabled entries dropped. */
export function readWakeRoutes(raw: Record<string, WakeRouteConfig> | undefined): WakeRoute[] {
  if (!raw) return [];
  return Object.entries(raw)
    .filter(([, r]) => r.enabled !== false)
    .map(([id, r]) => ({
      id,
      phrase: r.phrase,
      personalityId: r.personality,
      privileged: r.privileged === true,
      enabled: true,
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Why the personality the operator was looking for is not in the pushed table.
 *
 * Said the SAME WAY wherever a route cannot be resolved, because the two
 * refusals — a `--route` that matched nothing, and a table with nothing in it —
 * have the same cause and drifting into two phrasings of it is how one of them
 * ends up stale.
 *
 * It states the RULE, never which personalities were withheld: the client is
 * not told, the wake surface deliberately does not enumerate privileged
 * personalities, and a message that guessed would be accusing a table it cannot
 * see. Do not make the server send the excluded list to improve this string.
 */
const WHY_A_PERSONALITY_IS_ABSENT =
  'A personality is absent from this table when it is privileged — its toolset can reach a ' +
  'tool the approval layer would stop and ask about, and the default wake surface excludes ' +
  'those by design (no toolset.yaml means every tool, so that counts). Opt one in with an ' +
  'explicit route in ~/.ethos/config.yaml: voice.wake.routes.<id>.phrase / .personality / ' +
  '.privileged: true.';

/**
 * Resolve `--route` — the PIN — against the table the SERVER pushed, never
 * against the local config, which is one contributor to that table and not the
 * table itself.
 *
 * WHAT `--route` MEANS NOW. It used to be compulsory and it used to mean "send
 * every utterance as this personality", because the daemon had no way to tell
 * one addressee from another. The server matches phrases now, so the phrase
 * picks the personality and the flag is optional. What is left for it is the
 * one thing a phrase cannot say: WHICH PHRASES THIS MICROPHONE ANSWERS TO. A
 * pinned host is dedicated to one route — say the pinned phrase and it answers,
 * say another agent's and it does not.
 *
 * It is NOT a way to skip the gate. Pinning that also meant "and no phrase
 * needed" would make one flag quietly re-open the hole the gate closed, on the
 * host most likely to be left running in a room unattended.
 *
 * No pin resolves to `{ route: null }` with no problem: that is the ordinary
 * case, and it means every enabled route may address this host.
 */
export function resolveRoutePin(
  pushed: readonly WakeRoute[],
  requested: string | undefined,
): { route: WakeRoute | null; problem?: string } {
  if (requested === undefined) return { route: null };
  const routes = pushed.filter((r) => r.enabled);
  // Matched by whole id and nothing else: a synthesized id is
  // `auto:<personalityId>`, and `:` is outside the charset a config id may
  // use, so there is never an ambiguity between the two kinds.
  const found = routes.find((r) => r.id === requested);
  if (found) return { route: found };
  return {
    route: null,
    problem:
      `the server's wake route table has no enabled route '${requested}' — ` +
      (routes.length > 0
        ? `it pushed: ${routes.map((r) => `${r.id} ("${r.phrase}" → ${r.personalityId})`).join(', ')}. ` +
          'A synthesized route is named auto:<personalityId>. '
        : 'it pushed an empty table. ') +
      WHY_A_PERSONALITY_IS_ABSENT,
  };
}

/**
 * Why an empty pushed table is a warning and no longer a refusal.
 *
 * It used to stop the boot: the daemon had to pick one route up front, and
 * there was none to pick. Now the daemon picks nothing — the server matches
 * each transcript against whatever table it holds at that moment — and a
 * Settings save pushes a new one down the open socket. Refusing to start would
 * mean an operator who fixes their config still has to walk to the Pi.
 */
export const EMPTY_TABLE_WARNING =
  'the server pushed an EMPTY wake route table — no phrase can address this deployment ' +
  'yet, so every utterance will be transcribed and discarded. Every unprivileged ' +
  'personality gets a synthesized route for its own NAME automatically, so an empty table ' +
  `means there are none. ${WHY_A_PERSONALITY_IS_ABSENT} ` +
  'A Settings save reaches this daemon without a restart.';
