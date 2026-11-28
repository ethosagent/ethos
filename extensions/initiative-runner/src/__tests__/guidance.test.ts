import type { GuidanceMapping } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { mapGuidance, mergeGuidance } from '../index';

const ctx = (toolset: string[], level: 'personality' | 'initiative' | 'idea' = 'initiative') => ({
  toolset,
  level,
});

describe('mapGuidance', () => {
  it('R8 guidance is advice, not permission', () => {
    const [m] = mapGuidance(['go ahead and post in #general'], ctx(['send_message']));
    expect(m?.status).toBe('refused');
    expect(m?.mapsTo).toEqual([]);
    expect(m?.reason).toBeTruthy();
    const [f] = mapGuidance(['read ~/secrets'], ctx(['read_file']));
    expect(f?.status).toBe('refused');
    expect(f?.reason).toContain('add a source instead');
  });

  it('refuses guidance naming a filesystem path, not URLs or domains', () => {
    for (const t of [
      'read ~/secrets',
      'look at /etc/passwd',
      'check the .env file',
      'use server.pem',
      'open id_rsa',
    ]) {
      expect(mapGuidance([t], ctx(['read_file', 'web_search']))[0]?.status).toBe('refused');
    }
    const [u] = mapGuidance(['read https://example.com/docs/changelog'], ctx(['web_search']));
    expect(u).toMatchObject({ status: 'mapped', mapsTo: ['web_search:example.com'] });
    const [d] = mapGuidance(['read the changelog updates on example.com'], ctx(['web_search']));
    expect(d).toMatchObject({ status: 'mapped', mapsTo: ['web_search:example.com'] });
  });

  it('refuses every acting imperative', () => {
    for (const t of [
      'send the report',
      'create a ticket',
      'message the team',
      'email the customer',
      'file a ticket for it',
      'schedule a call',
      'reply to the thread',
      'tweet the launch',
      'DM the founder',
      'publish the draft',
      'comment on the issue',
      'delete the file',
      'upload the report',
      'invite the team',
      'buy the plan',
      'purchase a license',
      'deploy the fix',
      'merge the branch',
      'push the change',
      'update the doc',
    ]) {
      expect(mapGuidance([t], ctx([]))[0]?.status).toBe('refused');
    }
  });

  it('LinkedIn maps when the toolset has it', () => {
    const [m] = mapGuidance(['look at LinkedIn posts'], ctx(['linkedin_search']));
    expect(m).toMatchObject({ status: 'mapped', mapsTo: ['linkedin_search'] });
  });

  it('LinkedIn unreachable when it does not', () => {
    const [m] = mapGuidance(['look at LinkedIn posts'], ctx(['web_search']));
    expect(m?.status).toBe('unreachable');
    expect(m?.reason).toContain("not in this personality's toolset");
  });

  it('Mixpanel is unreachable', () => {
    const [m] = mapGuidance(['check Mixpanel funnels'], ctx(['web_search']));
    expect(m).toMatchObject({ status: 'unreachable', mapsTo: [] });
    expect(m?.reason).toContain('no read-only connector');
  });

  it('Slack channels are unreachable', () => {
    expect(mapGuidance(['read the #support channel in Slack'], ctx([]))[0]?.status).toBe(
      'unreachable',
    );
  });

  it('a domain maps to web_search:<host>', () => {
    const [m] = mapGuidance(['read reviews on g2.com'], ctx(['web_search']));
    expect(m).toMatchObject({ status: 'mapped', mapsTo: ['web_search:g2.com'] });
  });

  it('G2 by name maps to its host', () => {
    const [m] = mapGuidance(['see what G2 says'], ctx(['web_search']));
    expect(m?.mapsTo).toEqual(['web_search:g2.com']);
  });

  it('Reddit prefers reddit_web_search, falls back to reddit_search', () => {
    expect(
      mapGuidance(['scan Reddit'], ctx(['reddit_search', 'reddit_web_search']))[0]?.mapsTo,
    ).toEqual(['reddit_web_search']);
    expect(mapGuidance(['scan Reddit'], ctx(['reddit_search']))[0]?.mapsTo).toEqual([
      'reddit_search',
    ]);
  });

  it('X / Twitter maps to x_search', () => {
    expect(mapGuidance(['watch Twitter'], ctx(['x_search']))[0]?.mapsTo).toEqual(['x_search']);
    expect(mapGuidance(['watch X for mentions'], ctx(['x_search']))[0]?.status).toBe('mapped');
  });

  it('our code maps to read_file', () => {
    expect(mapGuidance(['look in our code'], ctx(['read_file']))[0]).toMatchObject({
      status: 'mapped',
      mapsTo: ['read_file'],
    });
  });

  it('unknown guidance stays mapped with no tool (pure advice)', () => {
    const [m] = mapGuidance(['prefer concrete numbers'], ctx([]));
    expect(m).toMatchObject({ status: 'mapped', mapsTo: [], text: 'prefer concrete numbers' });
  });

  it('is deterministic and preserves order and text', () => {
    const lines = ['look at LinkedIn', 'check Mixpanel'];
    const a = mapGuidance(lines, ctx(['linkedin_search']));
    expect(a.map((m) => m.text)).toEqual(lines);
    expect(mapGuidance(lines, ctx(['linkedin_search']))).toEqual(a);
  });
});

describe('mergeGuidance', () => {
  const g = (text: string, mapsTo: string[] = []): GuidanceMapping => ({
    text,
    status: 'mapped',
    mapsTo,
  });

  it('idea level beats initiative level', () => {
    const r = mergeGuidance(
      [g('look at LinkedIn', ['a'])],
      [g('look at LinkedIn', ['b'])],
      [g('look at LinkedIn', ['c'])],
    );
    expect(r).toHaveLength(1);
    expect(r[0]?.mapsTo).toEqual(['c']);
  });

  it('initiative beats personality; distinct lines are all kept', () => {
    const r = mergeGuidance([g('p', ['1']), g('shared', ['1'])], [g('shared', ['2'])], []);
    expect(r.find((x) => x.text === 'shared')?.mapsTo).toEqual(['2']);
    expect(r.map((x) => x.text).sort()).toEqual(['p', 'shared']);
  });

  it('matches case- and whitespace-insensitively', () => {
    const r = mergeGuidance([g('Look  at LinkedIn')], [], [g('look at linkedin', ['x'])]);
    expect(r).toHaveLength(1);
    expect(r[0]?.mapsTo).toEqual(['x']);
  });
});
