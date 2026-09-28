// plan personality-memory-boundary G1 (verification round B16) — `/ethos ask`
// decides the room AUDIENCE on the conversation id alone: only a `D…` id is
// provably a one-to-one `im`. `isSlackDm` also accepts
// `channel_name === 'directmessage'` for routing; that alone must not make the
// turn private, so the submitter hints any other id shared
// (`SlackAdapter.makeAskSubmitter` → `InboundMessage.audienceHint`).
//
// The real Bolt App is constructed but never started, as in observe-media.test.ts.

import type { InboundMessage } from '@ethosagent/types';
import { beforeAll, describe, expect, it } from 'vitest';
import { SlackAdapter } from '../adapter';
import { loadSlackSdk } from '../sdk';
import { stubSlackWebApi } from './stub-slack-web-api';

beforeAll(async () => {
  await loadSlackSdk();
});

stubSlackWebApi();

type Submit = (input: {
  channel: string;
  user: string;
  text: string;
  isDm: boolean;
}) => Promise<void>;

async function submitted(channel: string, isDm: boolean): Promise<InboundMessage | undefined> {
  const adapter = new SlackAdapter({
    botToken: 'xoxb-fake',
    appToken: 'xapp-fake',
    signingSecret: 'sig-fake',
    botKey: 'test-bot',
  });
  const seen: InboundMessage[] = [];
  adapter.onMessage((m) => seen.push(m));
  const submit = (
    adapter as unknown as { makeAskSubmitter(): Submit | undefined }
  ).makeAskSubmitter();
  await submit?.({ channel, user: 'U1', text: 'hi', isDm });
  return seen[0];
}

describe('/ethos ask — room audience', () => {
  it('a D… conversation is a DM with no shared hint', async () => {
    const m = await submitted('D0123', true);
    expect(m?.isDm).toBe(true);
    expect(m?.audienceHint).toBeUndefined();
  });

  it('a non-D id routed as a DM by channel_name is still hinted shared', async () => {
    const m = await submitted('G0123', true);
    expect(m?.isDm).toBe(true);
    expect(m?.audienceHint).toBe('shared');
  });

  it('a channel is not a DM', async () => {
    const m = await submitted('C0123', false);
    expect(m?.isDm).toBe(false);
  });
});
