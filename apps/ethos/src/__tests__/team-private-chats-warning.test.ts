// plan personality-memory-boundary G1, verification round B9 — the one-time
// startup warning `buildGateway` prints for a team deployment whose
// `gateway.private_chats` lists no room (`teamPrivateChatsWarning`).

import { describe, expect, it } from 'vitest';
import { teamPrivateChatsWarning } from '../commands/gateway';

const team = { binding: { type: 'team' as const, name: 'eng' } };
const personality = { binding: { type: 'personality' as const, name: 'default' } };

describe('teamPrivateChatsWarning', () => {
  it('warns for a team binding with no trusted rooms', () => {
    const warning = teamPrivateChatsWarning([personality, team], undefined);
    expect(warning).toContain('team eng');
    expect(warning).toContain('gateway.private_chats');
    expect(teamPrivateChatsWarning([team], { slack: [] })).toBeDefined();
  });

  it('is silent with no team binding, or once any room is listed', () => {
    expect(teamPrivateChatsWarning([personality], undefined)).toBeUndefined();
    expect(teamPrivateChatsWarning([team], { slack: ['C0TEAM'] })).toBeUndefined();
  });
});
