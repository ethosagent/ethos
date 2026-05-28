import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isSafePathSegment } from '@ethosagent/storage-fs';
import { getStorage } from '../wiring';

const c = {
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  reset: '\x1b[0m',
  green: '\x1b[32m',
};
export async function runPersonalityCreate(args) {
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
function parseFlags(args) {
  let name;
  let blank = false;
  let nonInteractive = false;
  let from;
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
async function scaffoldBlank(name) {
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
  const { ethosDir } = await import('../config');
  const dir = join(ethosDir(), 'personalities', id);
  if (existsSync(dir)) {
    console.error(`Personality "${id}" already exists at ${dir}`);
    process.exit(1);
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SOUL.md'), `# ${name}\n\nDescribe this personality's identity here.\n`);
  writeFileSync(
    join(dir, 'config.yaml'),
    `name: ${yamlScalar(name)}\ndescription: \nmodel: claude-sonnet-4-6\n`,
  );
  writeFileSync(join(dir, 'toolset.yaml'), '- read_file\n- write_file\n- terminal\n');
  console.log(`\n${c.bold}Created personality "${id}"${c.reset}  ${c.dim}${dir}${c.reset}`);
  console.log(`${c.dim}Edit the files, then test: ethos chat --personality ${id}${c.reset}\n`);
}
/** Escape a value for safe YAML scalar emission. */
function yamlScalar(value) {
  if (/[:\n\r#[\]{}&*!|>'"%@`]/.test(value) || value.trim() !== value) {
    return JSON.stringify(value);
  }
  return value;
}
async function scaffoldFrom(sourceId, targetName) {
  if (!targetName) {
    console.error('Usage: ethos personality create <name> --from <source-id>');
    process.exit(1);
  }
  const { createPersonalityRegistry } = await import('@ethosagent/personalities');
  const reg = await createPersonalityRegistry();
  await reg.duplicate(sourceId, targetName.toLowerCase().replace(/\s+/g, '-'));
  console.log(`\n${c.bold}Created personality "${targetName}" from "${sourceId}"${c.reset}`);
  console.log(
    `${c.dim}Test: ethos chat --personality ${targetName.toLowerCase().replace(/\s+/g, '-')}${c.reset}\n`,
  );
}
async function runAiAssisted(name) {
  const { readConfig } = await import('../config');
  const { getSecretsResolver } = await import('../wiring');
  const { runChat } = await import('./chat');
  const { createPersonalityRegistry } = await import('@ethosagent/personalities');
  const config = await readConfig(getStorage(), await getSecretsResolver());
  if (!config) {
    console.error('Run `ethos setup` first.');
    process.exit(1);
  }
  const reg = await createPersonalityRegistry();
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
  await runChat(overridden, {
    ...(prompt ? { singleQuery: prompt } : {}),
  });
}
