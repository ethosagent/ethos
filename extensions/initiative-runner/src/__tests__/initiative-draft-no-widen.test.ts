import { homedir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { checkSources } from '../index';

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
