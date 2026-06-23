import type { ContextEngine } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { validateContextEngine } from '../context-engines/conformance';
import { DefaultContextEngineRegistry } from '../context-engines/registry';

describe('validateContextEngine conformance harness', () => {
  describe('built-in engines', () => {
    const registry = new DefaultContextEngineRegistry();
    for (const name of registry.names()) {
      it(`${name} passes conformance`, async () => {
        const engine = registry.get(name);
        expect(engine).toBeDefined();
        if (!engine) return;
        const result = await validateContextEngine(engine);
        expect(result.failures).toEqual([]);
        expect(result.passed).toBe(true);
      });
    }
  });

  describe('broken engine', () => {
    it('catches missing messages', async () => {
      const broken: ContextEngine = {
        name: 'broken',
        // biome-ignore lint/suspicious/noExplicitAny: testing invalid engine output
        compact: async () => ({ messages: undefined as any, notes: '' }),
      };
      const result = await validateContextEngine(broken);
      expect(result.passed).toBe(false);
      expect(result.failures.length).toBeGreaterThan(0);
    });

    it('catches invalid role', async () => {
      const broken: ContextEngine = {
        name: 'bad-role',
        compact: async () => ({
          // biome-ignore lint/suspicious/noExplicitAny: testing invalid engine output
          messages: [{ role: 'system' as any, content: 'test' }],
          notes: 'ok',
        }),
      };
      const result = await validateContextEngine(broken);
      expect(result.passed).toBe(false);
      expect(result.failures.some((f) => f.includes('role'))).toBe(true);
    });

    it('catches empty notes', async () => {
      const broken: ContextEngine = {
        name: 'empty-notes',
        compact: async () => ({
          messages: [{ role: 'user', content: 'hi' }],
          notes: '',
        }),
      };
      const result = await validateContextEngine(broken);
      expect(result.passed).toBe(false);
      expect(result.failures.some((f) => f.includes('notes'))).toBe(true);
    });

    it('catches invalid cacheBreakpoints', async () => {
      const broken: ContextEngine = {
        name: 'bad-bp',
        compact: async () => ({
          messages: [{ role: 'user', content: 'hi' }],
          notes: 'ok',
          cacheBreakpoints: [5],
        }),
      };
      const result = await validateContextEngine(broken);
      expect(result.passed).toBe(false);
      expect(result.failures.some((f) => f.includes('cacheBreakpoint'))).toBe(true);
    });

    it('catches invalid removed entry', async () => {
      const broken: ContextEngine = {
        name: 'bad-removed',
        compact: async () => ({
          messages: [{ role: 'user', content: 'hi' }],
          notes: 'ok',
          removed: [{ index: -1, reason: 'trimmed' }],
        }),
      };
      const result = await validateContextEngine(broken);
      expect(result.passed).toBe(false);
      expect(result.failures.some((f) => f.includes('removed'))).toBe(true);
    });

    it('catches invalid summary sourceRange', async () => {
      const broken: ContextEngine = {
        name: 'bad-summary',
        compact: async () => ({
          messages: [{ role: 'user', content: 'hi' }],
          notes: 'ok',
          summaries: [{ text: 'sum', sourceRange: [5, 3] }],
        }),
      };
      const result = await validateContextEngine(broken);
      expect(result.passed).toBe(false);
      expect(result.failures.some((f) => f.includes('sourceRange'))).toBe(true);
    });

    it('catches engine that throws', async () => {
      const broken: ContextEngine = {
        name: 'throws',
        compact: async () => {
          throw new Error('boom');
        },
      };
      const result = await validateContextEngine(broken);
      expect(result.passed).toBe(false);
      expect(result.failures.some((f) => f.includes('threw'))).toBe(true);
    });
  });

  describe('minimal valid engine', () => {
    it('passes with minimal correct output', async () => {
      const minimal: ContextEngine = {
        name: 'minimal',
        compact: async (opts) => ({
          messages: opts.messages,
          notes: 'no compaction needed',
        }),
      };
      const result = await validateContextEngine(minimal);
      expect(result.failures).toEqual([]);
      expect(result.passed).toBe(true);
    });
  });
});
