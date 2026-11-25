import { ROOM_MODES } from '@ethosagent/web-contracts';
import { describe, expect, it } from 'vitest';
import { CHANNEL_MODES as DISCORD } from '../../../../extensions/platform-discord/src/config';
import { CHANNEL_MODES as SLACK } from '../../../../extensions/platform-slack/src/config';
import { CHANNEL_MODES as TELEGRAM } from '../../../../extensions/platform-telegram/src/config';
import { CHANNEL_MODES as WHATSAPP } from '../../../../extensions/platform-whatsapp/src/config';

// `ROOM_MODES` (packages/web-contracts/src/schema/communications.ts) is a hand-kept
// mirror of each adapter's `CHANNEL_MODES`: web-contracts cannot import the platform
// packages. The adapters' config modules are read by path (no adapter side effects, and
// platform-whatsapp is not a web-api dependency). Order matters: the UI lists them as given.
describe('ROOM_MODES mirrors every adapter CHANNEL_MODES', () => {
  it.each([
    ['slack', SLACK],
    ['discord', DISCORD],
    ['telegram', TELEGRAM],
    ['whatsapp', WHATSAPP],
  ] as const)('%s', (platform, modes) => {
    expect([...ROOM_MODES[platform]]).toEqual([...modes]);
  });
});
