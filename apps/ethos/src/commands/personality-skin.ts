import { join } from 'node:path';
import { BUILTIN_SKIN_NAMES, BUILTIN_SKINS } from '@ethosagent/design-tokens';
import { createPersonalityRegistry } from '@ethosagent/personalities';
import { ethosDir } from '../config';
import { getStorage } from '../wiring';

// `ethos personality skin` — read/write the `skin:` field on a personality's
// config.yaml. Mirrors the Web UI's Personalities → Edit modal control.
//
// Modes:
//   ethos personality skin                    → list every personality + its current skin
//   ethos personality skin <id>               → show that personality's current skin
//   ethos personality skin <id> <name>        → set
//   ethos personality skin <id> --clear       → drop the override
//
// Built-in personalities are read-only — same constraint that applies to
// mcp / plugins / config edits. The error from the registry surfaces with a
// `personality duplicate <id> <new-id>` hint so users know the unblock.

const USAGE = 'Usage: ethos personality skin [<id> [<name> | --clear]]';

export async function runPersonalitySkin(argv: string[]): Promise<void> {
  const id = argv[0];
  const second = argv[1];

  const storage = getStorage();
  const reg = await createPersonalityRegistry({ storage, userPersonalitiesDir: ethosDir() });
  await reg.loadFromDirectory(join(ethosDir(), 'personalities'));

  // No id → print a table of every personality + its current skin override.
  if (!id) {
    const all = reg.describeAll();
    console.log('\nPersonality skins:\n');
    for (const d of all) {
      const skin = d.config.skin ?? '(none — uses global default)';
      const tag = d.builtin ? ' [built-in]' : '';
      console.log(`  ${d.config.id.padEnd(16)} ${skin}${tag}`);
    }
    console.log(
      `\nBuilt-in skins: ${BUILTIN_SKIN_NAMES.join(' · ')}. Duplicate a built-in personality to edit its skin.\n`,
    );
    return;
  }

  const target = reg.describe(id);
  if (!target) {
    console.error(`Unknown personality: ${id}`);
    console.error('Run `ethos personality list` to see available ids.');
    process.exit(1);
  }

  // No second arg → show the current value (read-only inspection works on
  // built-ins too).
  if (!second) {
    const skin = target.config.skin ?? '(none — uses global default)';
    const tag = target.builtin ? ' [built-in, read-only]' : '';
    console.log(`\n${id}: ${skin}${tag}\n`);
    return;
  }

  // Two arms from here: `--clear` or a named skin.
  if (second === '--clear') {
    if (target.config.skin === undefined) {
      console.log(`\n${id} has no skin override — nothing to clear.\n`);
      return;
    }
    try {
      await reg.update(id, { skin: null });
      console.log(`✓ Cleared skin override on ${id}`);
    } catch (err) {
      console.error(formatError(err));
      process.exit(1);
    }
    return;
  }

  // Validate against the built-in skin registry. Custom YAML skins are a
  // follow-up; until they land, only the names here are real.
  if (!BUILTIN_SKINS[second]) {
    console.error(`Unknown skin: ${second}`);
    console.error(`Available: ${BUILTIN_SKIN_NAMES.join(' · ')}`);
    process.exit(1);
  }

  try {
    await reg.update(id, { skin: second });
    console.log(`✓ Set ${id} skin to "${second}"`);
  } catch (err) {
    console.error(formatError(err));
    if (target.builtin) {
      console.error(
        `Tip: built-ins are read-only. Run \`ethos personality duplicate ${id} my-${id}\`, then \`ethos personality skin my-${id} ${second}\`.`,
      );
    }
    process.exit(1);
  }
}

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export { USAGE as PERSONALITY_SKIN_USAGE };
