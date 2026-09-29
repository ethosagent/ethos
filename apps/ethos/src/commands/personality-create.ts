// `ethos personality create` — an OPERATOR create path, so every personality
// it makes is born (plan personality-presence-and-initiative §1): a birth
// marker and `propose_self_amendment` in its declared toolset, the same as the
// web create form (`PersonalitiesService.createBorn`). Its first private CLI or
// web conversation then runs the birth ritual
// (`createBirthRitualInjector`, packages/wiring/src/birth-ritual.ts).
//
// - `--blank` → `createBlankPersonality`: `FilePersonalityRegistry.create(…,
//   { birth: true })`, the very call the web form makes.
// - `--from` → `duplicateBornPersonality`: `duplicate`, then
//   `markPersonalityBorn` (extensions/personalities/src/birth.ts).
// - AI-assisted → the personality-architect's `scaffold_personality` writes the
//   files, bounded by D13 (a new personality holds no tool the architect
//   lacks); AFTER the chat, `birthScaffoldedPersonalities` runs
//   `markPersonalityBorn` on each user personality that appeared during it.
//   The filing tool is added by this command, not granted by the architect,
//   so D13 stays whole. Limitation: "appeared during it" is a directory diff,
//   so a personality another process created meanwhile (a recipe install) is
//   born too; and the ritual starts only once the architect chat has ended.
// Pinned by apps/ethos/src/commands/__tests__/personality-create-birth.test.ts.

import { join } from 'node:path';
import { isSafePathSegment } from '@ethosagent/storage-fs';
import { EthosError, IdValidationError, type Storage } from '@ethosagent/types';
import { createPersonalityRegistry, markPersonalityBorn } from '@ethosagent/wiring';
import { getStorage } from '../wiring';

const c = {
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  reset: '\x1b[0m',
  green: '\x1b[32m',
};

export async function runPersonalityCreate(args: string[]): Promise<void> {
  const flags = parseFlags(args);

  if (flags.blank || flags.nonInteractive) {
    await scaffoldBlank(flags.name);
    return;
  }

  if (flags.from) {
    await scaffoldFrom(flags.from, flags.name);
    return;
  }

  await runAiAssisted(flags.name);
}

interface CreateFlags {
  name?: string;
  blank: boolean;
  nonInteractive: boolean;
  from?: string;
}

function parseFlags(args: string[]): CreateFlags {
  let name: string | undefined;
  let blank = false;
  let nonInteractive = false;
  let from: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--blank') {
      blank = true;
    } else if (a === '--non-interactive') {
      nonInteractive = true;
    } else if (a === '--from' && args[i + 1]) {
      from = args[i + 1];
      i++;
    } else if (!a.startsWith('-') && !name) {
      name = a;
    }
  }

  return { name, blank, nonInteractive, from };
}

async function scaffoldBlank(name: string | undefined): Promise<void> {
  if (!name) {
    console.error('Usage: ethos personality create <name> --blank');
    process.exit(1);
  }

  const id = name.toLowerCase().replace(/\s+/g, '-');
  if (!isSafePathSegment(id)) {
    console.error(
      `Invalid personality name "${id}": must not contain path separators, "..", or start with "."`,
    );
    process.exit(1);
  }
  const { ethosDir } = await import('@ethosagent/config');
  const dataDir = ethosDir();
  try {
    await createBlankPersonality(getStorage(), dataDir, name);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  const dir = join(dataDir, 'personalities', id);
  console.log(`\n${c.bold}Created personality "${id}"${c.reset}  ${c.dim}${dir}${c.reset}`);
  console.log(`${c.dim}Edit the files, then test: ethos chat --personality ${id}${c.reset}\n`);
}

/**
 * `--blank`: a born personality with a starter SOUL.md and toolset, through
 * `FilePersonalityRegistry.create(…, { birth: true })`. Resolves the new id.
 * Throws when the id is taken (a user directory of that name, or a built-in).
 */
export async function createBlankPersonality(
  storage: Storage,
  dataDir: string,
  name: string,
): Promise<string> {
  const id = name.toLowerCase().replace(/\s+/g, '-');
  if (await storage.exists(join(dataDir, 'personalities', id))) {
    throw new EthosError({
      code: 'PERSONALITY_EXISTS',
      cause: `Personality "${id}" already exists at ${join(dataDir, 'personalities', id)}`,
      action: 'Pick a different name.',
    });
  }
  const reg = await createPersonalityRegistry({ storage, userPersonalitiesDir: dataDir });
  await reg.create(
    {
      id,
      name,
      model: 'claude-sonnet-4-6',
      toolset: ['read_file', 'write_file', 'terminal'],
      soulMd: `# ${name}\n\nDescribe this personality's identity here.\n`,
    },
    { birth: true },
  );
  return id;
}

async function scaffoldFrom(sourceId: string, targetName: string | undefined): Promise<void> {
  if (!targetName) {
    console.error('Usage: ethos personality create <name> --from <source-id>');
    process.exit(1);
  }

  const { ethosDir } = await import('@ethosagent/config');
  const newId = targetName.toLowerCase().replace(/\s+/g, '-');
  try {
    await duplicateBornPersonality(getStorage(), ethosDir(), sourceId, newId);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  console.log(`\n${c.bold}Created personality "${targetName}" from "${sourceId}"${c.reset}`);
  console.log(`${c.dim}Test: ethos chat --personality ${newId}${c.reset}\n`);
}

/**
 * `--from`: copy a built-in or user personality, then make the copy born. The
 * registry is built with the user dir so `duplicate` has somewhere to write
 * (`userPathFor`) and can find a user source.
 */
export async function duplicateBornPersonality(
  storage: Storage,
  dataDir: string,
  sourceId: string,
  newId: string,
): Promise<void> {
  const reg = await createPersonalityRegistry({ storage, userPersonalitiesDir: dataDir });
  await reg.loadFromDirectory(join(dataDir, 'personalities'));
  await reg.duplicate(sourceId, newId);
  await markPersonalityBorn(storage, dataDir, newId);
}

/** The user personality directories that hold a `config.yaml`. */
export async function listUserPersonalityIds(
  storage: Storage,
  dataDir: string,
): Promise<Set<string>> {
  const dir = join(dataDir, 'personalities');
  const ids = new Set<string>();
  for (const entry of await storage.listEntries(dir)) {
    if (entry.isDir && (await storage.exists(join(dir, entry.name, 'config.yaml')))) {
      ids.add(entry.name);
    }
  }
  return ids;
}

/**
 * After the AI-assisted chat: make every user personality that was not there
 * before it (`before`, from {@link listUserPersonalityIds}) born. Resolves the
 * ids it marked, sorted. A directory whose name is not a safe id
 * (`markPersonalityBorn` → `assertSafeId` throws `IdValidationError`) is
 * skipped with a warning on stderr — no birth marker can be keyed by that
 * name, and one bad name must not leave the others unborn.
 */
export async function birthScaffoldedPersonalities(
  storage: Storage,
  dataDir: string,
  before: ReadonlySet<string>,
): Promise<string[]> {
  const created = [...(await listUserPersonalityIds(storage, dataDir))]
    .filter((id) => !before.has(id))
    .sort();
  const born: string[] = [];
  for (const id of created) {
    try {
      await markPersonalityBorn(storage, dataDir, id);
      born.push(id);
    } catch (err) {
      if (!(err instanceof IdValidationError)) throw err;
      console.error(`Skipping personality directory "${id}": not a valid personality id.`);
    }
  }
  return born;
}

async function runAiAssisted(name: string | undefined): Promise<void> {
  const { ethosDir, readConfig } = await import('@ethosagent/config');
  const { getSecretsResolver } = await import('../wiring');
  const { runChat } = await import('./chat');

  const config = await readConfig(getStorage(), await getSecretsResolver());
  if (!config) {
    console.error('Run `ethos setup` first.');
    process.exit(1);
  }

  const reg = await createPersonalityRegistry(getStorage());
  if (!reg.get('personality-architect')) {
    console.error(
      'personality-architect personality not found. Is the framework installed correctly?',
    );
    process.exit(1);
  }

  const overridden = { ...config, personality: 'personality-architect' };

  const prompt = name
    ? `I want to create a new personality called "${name}". Help me design it.`
    : undefined;

  console.log(`\n${c.bold}Personality Architect${c.reset}`);
  console.log(`${c.dim}I'll help you design a focused AI specialist. Let's start.${c.reset}\n`);

  const dataDir = ethosDir();
  const before = await listUserPersonalityIds(getStorage(), dataDir);
  await runChat(overridden, {
    ...(prompt ? { singleQuery: prompt } : {}),
  });
  const born = await birthScaffoldedPersonalities(getStorage(), dataDir, before);
  for (const id of born) {
    console.log(
      `${c.dim}"${id}" will run its birth ritual in its first chat: ethos chat --personality ${id}${c.reset}`,
    );
  }
}
