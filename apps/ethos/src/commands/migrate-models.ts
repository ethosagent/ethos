// `ethos migrate models` — D11(a) of plan/phases/model-registry.md.
//
// A configured model is never hidden: every `providers.<n>.model` (and, with no
// chain, the top-level `provider`/`model` pair) the registry does not already
// have is adopted into `modelRegistry.*` — one alias per model, an explicit
// `providers.<n>.id` where an entry lacks one (D24), and `modelRegistry.default`
// when the registry has none. The plan is `planChainModelImport`
// (`@ethosagent/config`), the same importer `modelRegistry.importChain` and the
// Settings save run, so the terminal and the browser cannot disagree about what
// "import" writes. Nothing is written until the diff has been shown and
// confirmed (`--yes` skips the question; a non-terminal without `--yes` is
// refused, never silently written).
//
// Scope, stated so it is not read as more: this adopts the provider chain's
// models. It does not yet rewrite personality declarations, `modelRouting`,
// auxiliary slots or team manifests (the rest of T3.5).

import { createInterface } from 'node:readline';
import {
  type CatalogModelLookup,
  type EthosConfig,
  planChainModelImport,
  readRawConfig,
  writeConfig,
} from '@ethosagent/config';
import { lookupCatalogModel } from '@ethosagent/wiring/model-catalog';
import { getSecretsResolver, getStorage } from '../wiring';

const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
};

const USAGE = [
  'Usage: ethos migrate models [--yes]',
  '',
  '  models  adopt every model your provider chain declares into modelRegistry.* —',
  '          one alias per providers.<n>.model — after printing the diff',
  '  --yes   write without asking (required when stdin is not a terminal)',
].join('\n');

/** The exact line a refused non-interactive run tells the operator to run. */
export const MIGRATE_MODELS_YES = 'ethos migrate models --yes';

/** Seams, every one defaulted; tests supply doubles so no test touches the
 *  user's config, the vault or a terminal. */
export interface MigrateCommandDeps {
  loadConfig?: () => Promise<EthosConfig | null>;
  saveConfig?: (next: EthosConfig) => Promise<void>;
  confirm?: (question: string) => Promise<boolean>;
  isTTY?: boolean;
  lookupCatalog?: CatalogModelLookup;
  out?: (line: string) => void;
}

function promptConfirm(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

function colour(line: string): string {
  if (line.startsWith('+')) return `${c.green}${line}${c.reset}`;
  if (line.startsWith('-')) return `${c.red}${line}${c.reset}`;
  return `${c.yellow}${line}${c.reset}`;
}

export async function runMigrate(args: string[], deps: MigrateCommandDeps = {}): Promise<void> {
  const out = deps.out ?? ((line: string) => console.log(line));
  if (args[0] !== 'models') {
    out(USAGE);
    process.exitCode = 1;
    return;
  }
  const yes = args.slice(1).some((a) => a === '--yes' || a === '-y');

  const config = await (deps.loadConfig ?? (() => readRawConfig(getStorage())))();
  if (!config) {
    out(
      `${c.red}✗${c.reset} No config found at ~/.ethos/config.yaml — run ${c.cyan}ethos setup${c.reset}.`,
    );
    process.exitCode = 1;
    return;
  }

  const plan = planChainModelImport(config, {
    lookupCatalog: deps.lookupCatalog ?? lookupCatalogModel,
  });
  if (plan.diff.length === 0) {
    out(
      `${c.green}✓${c.reset} Nothing to import — every model your provider chain declares is already in modelRegistry.`,
    );
    return;
  }

  out(`${c.bold}This will change ~/.ethos/config.yaml:${c.reset}`);
  for (const line of plan.diff) out(`  ${colour(line)}`);

  if (!yes) {
    const isTTY = deps.isTTY ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
    if (!isTTY) {
      out(
        `${c.red}✗${c.reset} Nothing written: stdin is not a terminal, so there is no one to confirm. Run: ${MIGRATE_MODELS_YES}`,
      );
      process.exitCode = 1;
      return;
    }
    const confirmed = await (deps.confirm ?? promptConfirm)('Write these changes? [y/N] ');
    if (!confirmed) {
      out(`${c.dim}Nothing written.${c.reset}`);
      return;
    }
  }

  const next: EthosConfig = {
    ...config,
    // `EthosConfig.providers` carries `apiKey` as a string (`parseConfigYaml`
    // fills `''`); an empty key renders no line.
    providers: plan.providers.map((entry) => ({ ...entry, apiKey: entry.apiKey ?? '' })),
    ...(plan.registry ? { modelRegistry: plan.registry } : {}),
  };
  await (
    deps.saveConfig ??
    (async (value: EthosConfig) => writeConfig(getStorage(), value, await getSecretsResolver()))
  )(next);

  for (const model of plan.adopted) {
    out(
      `${c.green}✓${c.reset} Adopted ${c.cyan}${model.alias}${c.reset} → ${model.modelId} on provider entry ${model.providerKey}`,
    );
  }
  if (plan.idsWritten.length > 0) {
    out(`${c.green}✓${c.reset} Made provider ids explicit: ${plan.idsWritten.join(', ')}`);
  }
  if (plan.defaultSet) {
    out(`${c.green}✓${c.reset} Default model: ${c.cyan}${plan.defaultSet}${c.reset}`);
  }
}
