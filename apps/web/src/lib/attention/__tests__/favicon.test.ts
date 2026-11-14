import { describe, expect, it } from 'vitest';
import {
  ATTENTION_DOT_COLOR,
  type FaviconCanvas,
  type FaviconContext,
  type FaviconDeps,
  renderDotFavicon,
} from '../favicon';

function makeDeps(opts: { ctx?: boolean; loadFails?: boolean } = {}) {
  const calls: string[] = [];
  const fills: string[] = [];
  const img = { tag: 'img' };
  let size = 0;
  const ctx: FaviconContext = {
    fillStyle: '',
    clearRect: () => {
      calls.push('clearRect');
    },
    drawImage: (i, ...a) => {
      calls.push('drawImage');
      expect(i).toBe(img);
      expect(a).toEqual([0, 0, 32, 32]);
    },
    beginPath: () => {
      calls.push('beginPath');
    },
    arc: (...a) => {
      calls.push(`arc:${a.join(',')}`);
    },
    fill: () => {
      calls.push('fill');
      fills.push(ctx.fillStyle);
    },
  };
  const canvas: FaviconCanvas = {
    width: 0,
    height: 0,
    getContext: () => (opts.ctx === false ? null : ctx),
    toDataURL: () => 'data:image/png;base64,FAKE',
  };
  const deps: FaviconDeps = {
    createCanvas: (s) => {
      size = s;
      canvas.width = s;
      canvas.height = s;
      return canvas;
    },
    loadImage: async () => {
      if (opts.loadFails) throw new Error('nope');
      return img;
    },
  };
  return { deps, calls, fills, getSize: () => size };
}

describe('renderDotFavicon', () => {
  it('draws the base icon then a top-right dot and returns the data URL', async () => {
    const { deps, calls, fills, getSize } = makeDeps();
    const out = await renderDotFavicon('/favicon.svg', deps);
    expect(out).toBe('data:image/png;base64,FAKE');
    expect(getSize()).toBe(32);
    expect(calls.filter((c) => c === 'drawImage')).toHaveLength(1);
    const draw = calls.indexOf('drawImage');
    const arc = calls.findIndex((c) => c.startsWith('arc:'));
    expect(draw).toBeLessThan(arc);
    expect(calls[arc]).toBe(`arc:24,8,7,0,${Math.PI * 2}`);
    expect(fills).toEqual([ATTENTION_DOT_COLOR]);
    expect(ATTENTION_DOT_COLOR).toBe('#F59E0B');
  });

  it('returns null when no 2d context is available', async () => {
    const { deps } = makeDeps({ ctx: false });
    expect(await renderDotFavicon('/favicon.svg', deps)).toBeNull();
  });

  it('returns null when the image fails to load', async () => {
    const { deps } = makeDeps({ loadFails: true });
    expect(await renderDotFavicon('/favicon.svg', deps)).toBeNull();
  });
});
