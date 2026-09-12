import { OUTBOUND_POLICY_PLATFORMS } from '@ethosagent/personalities';
import { SEND_MESSAGE_PLATFORMS } from '@ethosagent/tools-messaging';
import { describe, expect, it } from 'vitest';

// O-D2 — `outbound_policy.channels` names the platforms the approval gate
// applies to, and the gate lives inside `send_message`. The two rosters are
// therefore the same roster, held in two places on purpose:
// `OUTBOUND_POLICY_PLATFORMS` (extensions/personalities/src/index.ts) and
// `SEND_MESSAGE_PLATFORMS` (extensions/tools-messaging/src/index.ts) are
// sibling extensions, and neither may import the other. `packages/wiring` is
// the lowest layer that can see both, so the pin lives here.
//
// Drifting apart is silent in the dangerous direction: a platform added to
// `send_message` and not to the loader's list is refused at load for anyone
// trying to gate it, and one dropped from the loader's list while `send_message`
// still addresses it publishes ungated from a config that reads as gated.

describe('outbound_policy.channels ↔ send_message platform roster', () => {
  it('names exactly the platforms send_message can address, in the same order', () => {
    expect([...OUTBOUND_POLICY_PLATFORMS]).toEqual([...SEND_MESSAGE_PLATFORMS]);
  });

  // Guards the assertion above against passing vacuously if both lists were
  // ever emptied together.
  it('is not empty', () => {
    expect(OUTBOUND_POLICY_PLATFORMS.length).toBeGreaterThan(0);
  });
});
