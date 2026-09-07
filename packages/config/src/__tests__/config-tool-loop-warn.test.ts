// Item 12 — `toolLoop.maxToolCallsWarnAt` / `toolLoop.maxIdenticalToolCallsWarnAt`:
// soft-warn tiers under the agent loop's hard tool-call caps — and the caps
// themselves, `toolLoop.maxToolCallsPerTurn` / `toolLoop.maxIdenticalToolCalls`.

import { join } from 'node:path';
import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import { ethosDir, readRawConfig, writeConfig } from '../index';

describe('toolLoop soft-warn config parsing', () => {
  async function load(yaml: string) {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    await storage.write(join(ethosDir(), 'config.yaml'), yaml);
    return readRawConfig(storage);
  }

  const base = ['provider: ollama', 'model: llama3.2', 'apiKey: sk', 'personality: p'];

  it('parses both thresholds', async () => {
    const cfg = await load(
      [...base, 'toolLoop.maxToolCallsWarnAt: 40', 'toolLoop.maxIdenticalToolCallsWarnAt: 10'].join(
        '\n',
      ),
    );
    expect(cfg?.toolLoop).toEqual({ maxToolCallsWarnAt: 40, maxIdenticalToolCallsWarnAt: 10 });
  });

  it('parses a single threshold on its own', async () => {
    const cfg = await load([...base, 'toolLoop.maxToolCallsWarnAt: 12'].join('\n'));
    expect(cfg?.toolLoop).toEqual({ maxToolCallsWarnAt: 12 });
  });

  it('drops a non-positive or non-numeric threshold and keeps the rest', async () => {
    const cfg = await load(
      [...base, 'toolLoop.maxToolCallsWarnAt: 0', 'toolLoop.maxIdenticalToolCallsWarnAt: 8'].join(
        '\n',
      ),
    );
    expect(cfg?.toolLoop).toEqual({ maxIdenticalToolCallsWarnAt: 8 });
    const bad = await load([...base, 'toolLoop.maxToolCallsWarnAt: soon'].join('\n'));
    expect(bad?.toolLoop).toBeUndefined();
  });

  it('leaves toolLoop undefined when no keys are present (no warn tier)', async () => {
    const cfg = await load(base.join('\n'));
    expect(cfg?.toolLoop).toBeUndefined();
  });

  it('round-trips through writeConfig', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    const original = {
      provider: 'ollama',
      model: 'llama3.2',
      apiKey: 'sk',
      personality: 'researcher',
      toolLoop: {
        maxToolCallsWarnAt: 40,
        maxIdenticalToolCallsWarnAt: 10,
        maxToolCallsPerTurn: 2000,
        maxIdenticalToolCalls: 400,
      },
    };
    await writeConfig(storage, original, new InMemorySecretsResolver());
    const roundTripped = await readRawConfig(storage);
    expect(roundTripped?.toolLoop).toEqual(original.toolLoop);
  });

  describe('hard caps', () => {
    it('parses both caps', async () => {
      const cfg = await load(
        [...base, 'toolLoop.maxToolCallsPerTurn: 2000', 'toolLoop.maxIdenticalToolCalls: 400'].join(
          '\n',
        ),
      );
      expect(cfg?.toolLoop).toEqual({ maxToolCallsPerTurn: 2000, maxIdenticalToolCalls: 400 });
    });

    it('drops 0, negative and non-numeric caps and keeps the rest', async () => {
      const cfg = await load(
        [
          ...base,
          'toolLoop.maxToolCallsPerTurn: 0',
          'toolLoop.maxIdenticalToolCalls: 400',
          'toolLoop.maxToolCallsWarnAt: 40',
        ].join('\n'),
      );
      expect(cfg?.toolLoop).toEqual({ maxIdenticalToolCalls: 400, maxToolCallsWarnAt: 40 });
      const negative = await load([...base, 'toolLoop.maxIdenticalToolCalls: -5'].join('\n'));
      expect(negative?.toolLoop).toBeUndefined();
      const text = await load([...base, 'toolLoop.maxToolCallsPerTurn: lots'].join('\n'));
      expect(text?.toolLoop).toBeUndefined();
    });

    it('floors a fractional cap', async () => {
      const cfg = await load([...base, 'toolLoop.maxIdenticalToolCalls: 30.9'].join('\n'));
      expect(cfg?.toolLoop).toEqual({ maxIdenticalToolCalls: 30 });
    });

    it('drops a warn tier at or above its hard cap and keeps the cap', async () => {
      const equal = await load(
        [
          ...base,
          'toolLoop.maxIdenticalToolCallsWarnAt: 25',
          'toolLoop.maxIdenticalToolCalls: 25',
        ].join('\n'),
      );
      expect(equal?.toolLoop).toEqual({ maxIdenticalToolCalls: 25 });
      const above = await load(
        [...base, 'toolLoop.maxToolCallsWarnAt: 500', 'toolLoop.maxToolCallsPerTurn: 100'].join(
          '\n',
        ),
      );
      expect(above?.toolLoop).toEqual({ maxToolCallsPerTurn: 100 });
      // The other pair is untouched by the check.
      const mixed = await load(
        [
          ...base,
          'toolLoop.maxToolCallsWarnAt: 500',
          'toolLoop.maxToolCallsPerTurn: 100',
          'toolLoop.maxIdenticalToolCallsWarnAt: 10',
          'toolLoop.maxIdenticalToolCalls: 400',
        ].join('\n'),
      );
      expect(mixed?.toolLoop).toEqual({
        maxToolCallsPerTurn: 100,
        maxIdenticalToolCallsWarnAt: 10,
        maxIdenticalToolCalls: 400,
      });
    });

    it('keeps a warn tier below its hard cap', async () => {
      const cfg = await load(
        [
          ...base,
          'toolLoop.maxIdenticalToolCallsWarnAt: 10',
          'toolLoop.maxIdenticalToolCalls: 400',
        ].join('\n'),
      );
      expect(cfg?.toolLoop).toEqual({
        maxIdenticalToolCallsWarnAt: 10,
        maxIdenticalToolCalls: 400,
      });
    });
  });
});
