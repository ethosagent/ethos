// `ethos personality birth skip <id>` — the owner declines a personality's
// birth ritual (plan personality-presence-and-initiative §1).
//
// A personality the owner creates carries a birth marker
// (`learning/birth/<id>.json`, extensions/personalities/src/birth.ts) until an
// identity amendment for it is applied. While it exists, the birth-ritual
// injector (`createBirthRitualInjector`, packages/wiring/src/birth-ritual.ts)
// asks the personality to run the ritual in private CLI and web turns. This
// command removes the marker, so the ritual never runs again. It changes
// nothing about the personality itself.
//
// Pinned by apps/ethos/src/commands/__tests__/personality-birth.test.ts.

import { assertSafeId, EthosError, type Storage } from '@ethosagent/types';
import { clearBirthMarker } from '@ethosagent/wiring';
import { splitJson, writeJson } from '../json-output';

export interface BirthCliDeps {
  /** Unscoped: the marker lives under `learning/`, which no turn can reach. */
  storage: Storage;
  dataDir: string;
  /** One line; a newline is added. */
  out(line: string): void;
  /** `--json`: print one `{ok:true,...}` document through `writeJson` instead of `out` lines. */
  json?: boolean;
}

const USAGE = [
  'Usage: ethos personality birth <command> [--json]',
  '',
  '  skip <id> [--json]   end the birth ritual for this personality (it will not ask again)',
];

export async function runPersonalityBirth(args: string[]): Promise<void> {
  const { ethosDir } = await import('@ethosagent/config');
  const { getStorage } = await import('../wiring');
  const { json, args: positional } = splitJson(args);
  // A thrown EthosError reaches the top-level catch in index.ts, which emits the --json error doc.
  await runPersonalityBirthCommand(positional, {
    storage: getStorage(),
    dataDir: ethosDir(),
    out: (line) => console.log(line),
    json,
  });
}

/** The command body, with every dependency injected. Throws `EthosError` on any failure. */
export async function runPersonalityBirthCommand(
  args: readonly string[],
  deps: BirthCliDeps,
): Promise<void> {
  const [sub, id] = args;
  if (sub === undefined || sub === 'help' || sub === '--help' || sub === '-h') {
    if (deps.json) writeJson({ ok: true, usage: USAGE.join('\n') });
    else for (const line of USAGE) deps.out(line);
    return;
  }
  if (sub !== 'skip') {
    throw new EthosError({
      code: 'INVALID_INPUT',
      cause: `Unknown subcommand: ${sub}`,
      action: 'Run `ethos personality birth help` for the commands.',
    });
  }
  if (!id || !isSafe(id)) {
    throw new EthosError({
      code: 'INVALID_INPUT',
      cause: id ? `Invalid personality id "${id}"` : 'A personality id is required',
      action: 'ethos personality birth skip <id>',
    });
  }
  const removed = await clearBirthMarker(deps.storage, deps.dataDir, id);
  if (deps.json) {
    writeJson({ ok: true, personality: id, skipped: removed });
    return;
  }
  deps.out(
    removed
      ? `Skipped the birth ritual for ${id}. It will not ask again.`
      : `${id} has no birth ritual waiting; nothing to skip.`,
  );
}

function isSafe(id: string): boolean {
  try {
    assertSafeId(id, 'personalityId');
    return true;
  } catch {
    return false;
  }
}
