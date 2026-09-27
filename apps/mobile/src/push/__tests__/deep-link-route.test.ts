import { describe, expect, it } from 'vitest';
import { deepLinkToRoute } from '../deep-link-route';

describe('deepLinkToRoute', () => {
  it('an approval with a sessionId opens that chat session', () => {
    expect(deepLinkToRoute({ category: 'approvals', sessionId: 's1' })).toBe('/chat/s1');
  });

  it('sessionId wins over a deepLink when both are present', () => {
    expect(
      deepLinkToRoute({
        category: 'clarify',
        sessionId: 's2',
        deepLink: 'ethos://p/engineer/chat',
      }),
    ).toBe('/chat/s2');
  });

  it('no sessionId (Android, no thread grouping) falls back to the deepLink personality', () => {
    expect(deepLinkToRoute({ category: 'approvals', deepLink: 'ethos://p/engineer/chat' })).toBe(
      '/chat/new?personalityId=engineer',
    );
  });

  it('no sessionId and no deepLink falls back to the chat tab', () => {
    expect(deepLinkToRoute({ category: 'clarify' })).toBe('/chat');
  });

  it('no sessionId and an unparseable deepLink falls back to the chat tab', () => {
    expect(deepLinkToRoute({ category: 'approvals', deepLink: 'not-a-valid-link' })).toBe('/chat');
  });

  it('team-attention opens the task it names', () => {
    expect(
      deepLinkToRoute({
        category: 'teamAttention',
        deepLink: 'ethos://t/marketing/task/MKT-38',
      }),
    ).toBe('/teams/marketing/task/MKT-38');
  });

  it('team-attention without a task link opens Teams', () => {
    expect(deepLinkToRoute({ category: 'teamAttention' })).toBe('/teams');
  });

  it('a cron failure opens Activity', () => {
    expect(deepLinkToRoute({ category: 'cronFailures' })).toBe('/activity');
  });

  it('a finished run opens Activity, even with a chat deepLink present', () => {
    expect(deepLinkToRoute({ category: 'runFinished', deepLink: 'ethos://p/engineer/chat' })).toBe(
      '/activity',
    );
  });

  it('an empty payload is a no-op', () => {
    expect(deepLinkToRoute({})).toBeNull();
  });

  it('an unrecognized category is a no-op regardless of deepLink', () => {
    expect(
      deepLinkToRoute({ category: 'somethingUnknown', deepLink: 'ethos://p/engineer/chat' }),
    ).toBeNull();
  });

  it('a deepLink with no category at all is a no-op', () => {
    expect(deepLinkToRoute({ deepLink: 'ethos://p/engineer/chat' })).toBeNull();
  });
});
