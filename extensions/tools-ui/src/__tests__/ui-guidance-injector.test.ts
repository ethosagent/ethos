// The injector's content lands in the STATIC prompt prefix. If it varied by
// turn it would defeat prefix caching everywhere (see the codebase note
// "Prompt ordering is static-first, dynamic-tail"), which is why the template
// catalog is a construction argument and not a per-turn directory listing.

import type { PromptContext } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { createUiGuidanceInjector } from '../ui-guidance-injector';

const ctx = { personalityId: 'trader', platform: 'web' } as unknown as PromptContext;

describe('ui-guidance injector', () => {
  it('emits byte-identical content across turns', async () => {
    const injector = createUiGuidanceInjector({
      personalityId: 'trader',
      templates: [{ name: 'market-brief', description: 'Daily brief' }],
    });
    const first = await injector.inject(ctx);
    const second = await injector.inject({ ...ctx, turnNumber: 7 } as PromptContext);
    expect(first?.content).toBe(second?.content);
  });

  it('teaches composition by shape, with recommend_actions last', async () => {
    const injector = createUiGuidanceInjector({ personalityId: 'trader', templates: [] });
    const result = await injector.inject(ctx);
    expect(result?.content).toContain('recommend_actions');
    expect(result?.content).toContain('Prose is the durable answer');
    expect(result?.content).toContain('data_table');
  });

  it('only injects for its own personality', () => {
    const injector = createUiGuidanceInjector({ personalityId: 'trader', templates: [] });
    expect(injector.shouldInject?.(ctx)).toBe(true);
    expect(injector.shouldInject?.({ ...ctx, personalityId: 'writer' } as PromptContext)).toBe(
      false,
    );
  });

  it('only injects on a surface that can draw cards', () => {
    const injector = createUiGuidanceInjector({ personalityId: 'trader', templates: [] });
    expect(injector.shouldInject?.({ ...ctx, platform: 'desktop' } as PromptContext)).toBe(true);
    expect(injector.shouldInject?.({ ...ctx, platform: 'cli' } as PromptContext)).toBe(false);
    expect(injector.shouldInject?.({ ...ctx, platform: 'slack' } as PromptContext)).toBe(false);
  });

  // plan telegram-live-cards D8
  describe('on telegram', () => {
    const tgCtx = { ...ctx, platform: 'telegram' } as unknown as PromptContext;
    const make = () =>
      createUiGuidanceInjector({
        personalityId: 'trader',
        templates: [{ name: 'market-brief', description: 'Daily brief' }],
      });

    it('injects for the personality', () => {
      expect(make().shouldInject?.(tgCtx)).toBe(true);
    });

    it('omits the canvas and template lines it cannot honour', async () => {
      const content = (await make().inject(tgCtx))?.content ?? '';
      expect(content).not.toContain('render_ui');
      expect(content).not.toContain('Canvas');
      expect(content).not.toContain('market-brief');
      expect(content).toContain('recommend_actions');
      expect(content).toContain('data_table');
    });

    it('says charts and wide tables arrive as text, and to name the options in prose too', async () => {
      const content = (await make().inject(tgCtx))?.content ?? '';
      expect(content).toContain('charts and wide tables arrive as text summaries');
      expect(content).toMatch(/name the options in prose/i);
    });

    it('is byte-identical across turns and across two builds (static prefix)', async () => {
      const a = await make().inject(tgCtx);
      const b = await make().inject({ ...tgCtx, turnNumber: 9 } as PromptContext);
      expect(a?.content).toBe(b?.content);
    });

    it('leaves the web content untouched', async () => {
      const web = (await make().inject(ctx))?.content ?? '';
      expect(web).toContain('render_ui');
      expect(web).toContain('market-brief');
      expect(web).not.toContain('text summaries');
    });
  });

  it('lists the template catalog', async () => {
    const injector = createUiGuidanceInjector({
      personalityId: 'trader',
      templates: [
        { name: 'market-brief', description: 'Daily market brief' },
        { name: 'sector-flow' },
      ],
    });
    const content = (await injector.inject(ctx))?.content ?? '';
    expect(content).toContain('- market-brief: Daily market brief');
    expect(content).toContain('- sector-flow');
    expect(content).not.toContain('- sector-flow:');
  });

  it('omits the catalog section entirely when there are no templates', async () => {
    const injector = createUiGuidanceInjector({ personalityId: 'trader', templates: [] });
    const content = (await injector.inject(ctx))?.content ?? '';
    expect(content).not.toContain('Canvas templates');
  });
});
