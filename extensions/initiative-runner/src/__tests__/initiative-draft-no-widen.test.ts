import { homedir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { parseInitiativeFile } from '../config-schema';
import { checkSources } from '../index';
import { DATA, draft, PERSONALITY, selfStartHarness } from './helpers/self-start-harness';

const HOME = homedir();
const base = { readableRoots: [`${HOME}/code`], blocked: [] as string[] };

describe('checkSources parent subset', () => {
  it('R6 subset check', () => {
    const app = { repo: `${HOME}/code/app` };
    const r = checkSources([app, 'web'], { ...base, parentSources: [app] });
    expect(r).toEqual({ ok: false, error: expect.stringContaining('"web"') });
    expect(checkSources([app], { ...base, parentSources: [app, 'web'] })).toEqual({ ok: true });
    expect(checkSources(['web'], { ...base, parentSources: [app, 'web'] })).toEqual({ ok: true });
  });

  it('a child path must sit inside a parent path', () => {
    const parent = [{ repo: `${HOME}/code/app` }];
    expect(
      checkSources([{ repo: `${HOME}/code/app/src` }], { ...base, parentSources: parent }).ok,
    ).toBe(true);
    expect(
      checkSources([{ repo: `${HOME}/code/other` }], { ...base, parentSources: parent }).ok,
    ).toBe(false);
    expect(checkSources([{ repo: `${HOME}/code` }], { ...base, parentSources: parent }).ok).toBe(
      false,
    );
  });

  it('a parent with no sources lets the child read nothing', () => {
    expect(checkSources(['memory'], { ...base, parentSources: [] }).ok).toBe(false);
  });
});

describe('materialiseDrafts parent subset', () => {
  const dir = `${DATA}/personalities/${PERSONALITY}/initiatives`;

  it('R6 a draft cannot loosen autonomy or the budget over its parent', async () => {
    const h = selfStartHarness();
    await h.seed(h.parentFile({ autonomy: { mode: 'ask' } }));
    const loosened = await h.scan('growth', [draft('Loose topic', 'autonomy: { mode: free }\n')]);
    expect(loosened.drafts[0]).toMatchObject({
      status: 'refused',
      reason: expect.stringContaining('looser than the parent'),
    });
    expect(await h.storage.list(dir)).toEqual([]);
  });

  it('a draft cannot run more often or longer than its parent', async () => {
    const h = selfStartHarness();
    await h.seed(h.parentFile());
    const timeline = (t: string) =>
      `timeline: { explore_windows: ${t}, window_minutes: 20, default_days: 7, review_on: '2026-12-20' }\n`;
    const often = await h.scan('growth', [draft('Often topic', timeline('["every 1h"]'))]);
    expect(often.drafts[0]).toMatchObject({
      status: 'refused',
      reason: expect.stringContaining('more windows per day'),
    });
    const longer = await h.scan('growth', [
      draft(
        'Longer topic',
        timeline('["every 6h"]').replace('default_days: 7', 'default_days: 30'),
      ),
    ]);
    expect(longer.drafts[0]).toMatchObject({
      status: 'refused',
      reason: expect.stringContaining('timeline.default_days'),
    });
    const ok = await h.scan('growth', [draft('Calm topic', timeline('["every 12h"]'))]);
    expect(ok.drafts[0]).toMatchObject({ status: 'materialised' });
  });

  it('what a draft leaves out is inherited from its parent, so it can only narrow', async () => {
    const h = selfStartHarness();
    await h.seed(
      h.parentFile({
        exclude: ['secrets.md'],
        autonomy: { mode: 'free_under', ask_above_usd: 0.5 },
      }),
    );
    await h.scan('growth', [draft('Narrow topic', 'budget: { usd_per_day: 0.1 }\n')]);
    const saved = parseInitiativeFile((await h.storage.read(`${dir}/narrow-topic.yaml`)) ?? '');
    expect(saved.ok && saved.file).toMatchObject({
      exclude: ['secrets.md'],
      autonomy: { mode: 'free_under', ask_above_usd: 0.5 },
    });
    // A draft that drops the parent's exclude list is refused, not defaulted.
    const dropped = await h.scan('growth', [draft('Dropped topic', 'exclude: []\n')]);
    expect(dropped.drafts[0]).toMatchObject({
      status: 'refused',
      reason: expect.stringContaining('secrets.md'),
    });
  });
});
