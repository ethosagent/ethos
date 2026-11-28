import { DefaultPersonalityRegistry, DefaultToolRegistry } from '@ethosagent/core';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import type { Constitution, LLMProvider } from '@ethosagent/types';
import { stringify } from 'yaml';
import { createTestSafety } from '../../../../../packages/core/src/__tests__/helpers/test-safety';
import {
  type InitiativeFile,
  type InitiativeSettings,
  parseInitiativeFile,
} from '../../config-schema';
import { InitiativeConfigService } from '../../config-service';
import { createInitiativeRunner } from '../../runner';
import { fakeLedger, ledgerTools, makeFile, NOW, type Step, scriptedLLM } from './fake-ledger';

export const DATA = '/data';
export const PERSONALITY = 'product-manager';

/** The real config service and runner over the fake ledger and an in-memory Storage. */
export function selfStartHarness(
  opts: { constitution?: Constitution['initiatives']; settings?: Partial<InitiativeSettings> } = {},
) {
  const storage = new InMemoryStorage();
  const ledger = fakeLedger();
  const constitution: Constitution = {
    initiatives: { selfStartPoolUsdPerDay: 0.5, maxSelfStarted: 2, ...opts.constitution },
  };
  const settings: InitiativeSettings = {
    enabled: true,
    selfStart: true,
    dailyBudgetUsd: 0,
    standingGuidance: [],
    ...opts.settings,
  };
  const config = new InitiativeConfigService({
    storage,
    dataDir: DATA,
    store: ledger,
    constitution: async () => constitution,
    settings: async () => settings,
    toolset: () => [],
    schedule: () => {},
    now: () => NOW.getTime(),
  });

  /** An initiative already on the ledger, with its file in Storage. */
  async function seed(
    file: InitiativeFile,
    meta: Parameters<typeof ledger.seedInitiative>[2] = {},
  ): Promise<InitiativeFile> {
    ledger.seedInitiative(file, PERSONALITY, meta);
    await storage.mkdir('/x');
    await storage.write(`/x/${file.id}.yaml`, stringify(file));
    return file;
  }

  function runner(llm: LLMProvider) {
    const personalities = new DefaultPersonalityRegistry();
    personalities.define({ id: PERSONALITY, name: PERSONALITY });
    return createInitiativeRunner({
      store: ledger,
      selfStart: {
        store: ledger,
        config,
        settings: async () => settings,
        constitution: async () => constitution,
      },
      load: async (id) => {
        const row = ledger.initiatives.get(id);
        const raw = row ? await storage.read(row.configPath) : null;
        const parsed = raw === null ? null : parseInitiativeFile(raw);
        if (!row || !parsed?.ok) return null;
        ledger.caps.set(id, parsed.file.budget.usd_per_day);
        return { personalityId: row.personalityId, file: parsed.file, sourcePaths: [] };
      },
      buildRegistry: ({ initiativeId }) => {
        const registry = new DefaultToolRegistry();
        for (const t of ledgerTools(ledger, initiativeId)) registry.register(t);
        return registry;
      },
      llm,
      safety: createTestSafety(),
      personalities,
      clock: () => NOW,
    });
  }

  /** One scan whose model suggests `drafts` (YAML bodies); returns the report. */
  async function scan(parentId: string, drafts: string[], costUsd = 0.05) {
    const steps: Step[] = drafts.map((draft_yaml) => ({
      name: 'initiative_propose',
      input: { kind: 'new_initiative', draft_yaml, why: 'a gap the sources show' },
    }));
    return runner(scriptedLLM([steps, []], costUsd).llm).runScan(parentId);
  }

  const parentFile = (patch: Record<string, unknown> = {}) =>
    makeFile({ id: 'growth', title: 'Growth', sources: ['sessions'], ...patch });

  return { storage, ledger, constitution, settings, config, seed, runner, scan, parentFile };
}

export const draft = (title: string, extra = ''): string =>
  `title: ${title}\noutcome: Learn about ${title}\nsources: [sessions]\n${extra}`;
