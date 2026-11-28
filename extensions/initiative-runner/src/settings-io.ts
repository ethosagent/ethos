import { join } from 'node:path';
import { validateInitiatives } from '@ethosagent/constitution';
import { sensitiveDenyPaths } from '@ethosagent/storage-fs';
import type { Constitution } from '@ethosagent/types';
import { isMap, isNode, isScalar, parseDocument, stringify } from 'yaml';
import { type InitiativeSettings, InitiativeSettingsSchema } from './config-schema';
import { checkSources } from './sources';

// Pure helpers for the web-api `InitiativesService`, the only writer of `settings.yaml` and the
// constitution `initiatives` block. They read and write nothing; the service owns the Storage
// calls. Pinned by __tests__/settings-io.test.ts and apps/web-api/src/__tests__/routes/initiatives-rpc.test.ts.

type Block = NonNullable<Constitution['initiatives']>;

export function initiativeSettingsPath(dataDir: string, personalityId: string): string {
  return join(dataDir, 'personalities', personalityId, 'initiatives', 'settings.yaml');
}

/** The L8 settings validator: strict, so `allowWrites` and friends fail. */
export function validateInitiativeSettings(
  raw: unknown,
): { ok: true; settings: InitiativeSettings } | { ok: false; error: string } {
  const r = InitiativeSettingsSchema.safeParse(raw);
  return r.success
    ? { ok: true, settings: r.data }
    : {
        ok: false,
        error: r.error.issues
          .map((i) => `${i.path.map(String).join('.') || '(root)'}: ${i.message}`)
          .join('; '),
      };
}

/** Lower `dailyBudgetUsd` to the smaller operator ceiling. 0 means "not set" and is left alone. */
export function clampInitiativeSettings(
  settings: InitiativeSettings,
  ceilings: Constitution['initiatives'],
): { settings: InitiativeSettings; clamps: string[] } {
  const caps = [ceilings?.maxUsdPerDayPerPersonality, ceilings?.maxUsdPerDay].filter(
    (c): c is number => c !== undefined,
  );
  const cap = caps.length > 0 ? Math.min(...caps) : undefined;
  if (cap === undefined || settings.dailyBudgetUsd <= cap) return { settings, clamps: [] };
  return {
    settings: { ...settings, dailyBudgetUsd: cap },
    clamps: [`dailyBudgetUsd ${settings.dailyBudgetUsd} → ${cap} (operator ceiling)`],
  };
}

export function renderInitiativeSettings(settings: InitiativeSettings): string {
  return stringify(settings);
}

/**
 * The constitution `initiatives` validator (extensions/constitution validateInitiatives: unknown
 * key, types) plus the root check: every `readableRoots` entry must pass `checkSources` against
 * the same blocked paths (`sensitiveDenyPaths`, which covers `~/.ssh`) an initiative source does.
 */
export function validateConstitutionInitiatives(
  raw: unknown,
  dataDir: string,
): { ok: true; block: Block } | { ok: false; error: string } {
  const block = validateInitiatives(raw);
  if ('error' in block) return { ok: false, error: block.error };
  const blocked = sensitiveDenyPaths([dataDir]);
  for (const root of block.readableRoots ?? []) {
    const r = checkSources([{ repo: root }], { readableRoots: [root], blocked });
    if (!r.ok) return { ok: false, error: `readableRoots refuses ${root}: ${r.error}` };
  }
  return { ok: true, block };
}

/**
 * Replace only the `initiatives` block of constitution.yaml, by splicing the new block over the
 * old one's source range (or appending it). Every other byte, comment and blank line stays as
 * written: re-serialising the whole document would re-space comments and re-pad flow lists. A
 * document that does not parse, or whose top level is not a block mapping, is refused. Pinned
 * by __tests__/settings-io.test.ts and the 'constitution save keeps other blocks' RPC test.
 */
export function renderConstitutionWithInitiatives(
  raw: string | null,
  block: Block,
): { ok: true; text: string } | { ok: false; error: string } {
  const source = raw ?? '';
  const doc = parseDocument(source);
  if (doc.errors.length > 0) {
    return { ok: false, error: `constitution.yaml is not valid YAML: ${doc.errors[0]?.message}` };
  }
  const added = stringify({ initiatives: block }).trimEnd();
  if (doc.contents === null)
    return {
      ok: true,
      text: `${source}${source === '' || source.endsWith('\n') ? '' : '\n'}${added}\n`,
    };
  if (!isMap(doc.contents) || doc.contents.flow === true) {
    return { ok: false, error: 'constitution must be a YAML block mapping' };
  }
  const pair = doc.contents.items.find((p) => isScalar(p.key) && p.key.value === 'initiatives');
  const start = isScalar(pair?.key) ? pair.key.range?.[0] : undefined;
  const end = isNode(pair?.value) ? pair.value.range?.[1] : undefined;
  if (pair === undefined) {
    return { ok: true, text: `${source}${source.endsWith('\n') ? '' : '\n'}${added}\n` };
  }
  if (start === undefined || end === undefined) {
    return { ok: false, error: 'could not locate the initiatives block in constitution.yaml' };
  }
  // The node's range swallows the blank lines that follow it; give them back.
  const tail = /\n*$/.exec(source.slice(start, end))?.[0] ?? '';
  const rest = source.slice(end);
  const sep = tail !== '' || rest.startsWith('\n') ? tail : '\n';
  return { ok: true, text: `${source.slice(0, start)}${added}${sep}${rest}` };
}
