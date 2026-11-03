import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EthosConfig } from '@ethosagent/config';
import { readRawConfig, writeConfig } from '@ethosagent/config';
import { teamsDir } from '@ethosagent/team-supervisor';
import { EthosError } from '@ethosagent/types';
import { splitJson, writeJson, writeJsonError } from '../json-output';
import { getSecretsResolver, getStorage } from '../wiring';

const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
};

function resolveTeamExists(name: string): void {
  // Check local ./team.yaml
  try {
    const src = readFileSync('./team.yaml', 'utf-8');
    if (src.match(new RegExp(`^name:\\s*${name}\\s*$`, 'm'))) return;
  } catch {
    // not found
  }
  // Check ~/.ethos/teams/<name>.yaml
  try {
    readFileSync(join(teamsDir(), `${name}.yaml`), 'utf-8');
    return;
  } catch {
    // not found
  }
  throw new EthosError({
    code: 'FILE_NOT_FOUND',
    cause: `No team manifest found for "${name}"`,
    action: `Create ~/.ethos/teams/${name}.yaml or place a team.yaml in the current directory matching that name.`,
  });
}

async function requireConfig(json: boolean): Promise<EthosConfig> {
  const cfg = await readRawConfig(getStorage());
  if (!cfg) {
    if (json) writeJsonError('CONFIG_MISSING', 'No config found. Run ethos setup first.');
    console.error('No config found. Run ethos setup first.');
    process.exit(1);
  }
  return cfg;
}

function printCurrent(config: EthosConfig): void {
  const ctx = config.activeContext;
  if (!ctx) {
    console.log(
      `\n${c.bold}Active context${c.reset}  ${c.dim}personality${c.reset}  ${c.cyan}${config.personality}${c.reset}`,
    );
    console.log(`${c.dim}(default — no explicit context set)${c.reset}\n`);
    return;
  }
  const label = ctx.type === 'team' ? 'team' : 'personality';
  console.log(
    `\n${c.bold}Active context${c.reset}  ${c.dim}${label}${c.reset}  ${c.cyan}${ctx.name}${c.reset}\n`,
  );
}

export async function runSet(argv: string[]): Promise<void> {
  const { json, args } = splitJson(argv);
  const sub = args[0]?.toLowerCase();

  // ethos set → show current
  if (!sub) {
    const config = await requireConfig(json);
    if (json) {
      writeJson({
        ok: true,
        personality: config.personality,
        activeContext: config.activeContext ?? null,
      });
      return;
    }
    printCurrent(config);
    return;
  }

  if (sub !== 'personality' && sub !== 'team') {
    const usage = 'Usage: ethos set [personality <name> | team <name>] [--json]';
    if (json) writeJsonError('INVALID_INPUT', usage);
    console.log(usage);
    return;
  }

  const name = args[1];
  if (!name) {
    const usage = `Usage: ethos set ${sub} <name> [--json]`;
    if (json) writeJsonError('INVALID_INPUT', usage);
    console.log(usage);
    return;
  }

  const config = await requireConfig(json);

  if (sub === 'team') {
    resolveTeamExists(name);
    await writeConfig(
      getStorage(),
      { ...config, activeContext: { type: 'team', name } },
      await getSecretsResolver(),
    );
    if (json) {
      writeJson({ ok: true, kind: 'team', name });
      return;
    }
    console.log(
      `${c.green}✓${c.reset} Active context set to ${c.bold}team:${name}${c.reset}\n` +
        `${c.dim}Start the team first: ethos team start ${name}${c.reset}`,
    );
  } else {
    // B3 / UD1 Option A — `personality:` is the one default-personality key.
    // A leftover personality-typed activeContext is cleared here (the parser
    // migrates disk copies, but a same-process object may still carry one);
    // a team activeContext is deliberately untouched.
    const { activeContext, ...rest } = config;
    await writeConfig(
      getStorage(),
      {
        ...rest,
        personality: name,
        ...(activeContext?.type === 'team' ? { activeContext } : {}),
      },
      await getSecretsResolver(),
    );
    if (json) {
      writeJson({ ok: true, kind: 'personality', name });
      return;
    }
    console.log(`${c.green}✓${c.reset} Default personality set to ${c.bold}${name}${c.reset}`);
  }
}
