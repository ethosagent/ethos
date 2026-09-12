import { createInterface, type Interface } from 'node:readline';
import {
  type EthosConfig,
  fillFromTopLevel,
  isProviderChainSecretRef,
  type ProviderConfig,
  readRawConfig,
  secretRefFromValue,
  writeConfig,
} from '@ethosagent/config';
import type { SecretsResolver } from '@ethosagent/types';
import { getSecretsResolver, getStorage } from '../wiring';

// `ethos fallback` — interactive editor for the `providers:` chain in
// ~/.ethos/config.yaml. The mechanism (ChainedProvider with cooldown-based
// automatic failover) already exists in @ethosagent/wiring; this command
// is the operator-facing surface for it.
//
// Subcommands:
//   ethos fallback list             — show current chain (numbered, masked api keys)
//   ethos fallback add              — interactive prompts; appends one entry
//   ethos fallback remove <index>   — remove the entry at <index> (1-based)
//   ethos fallback clear            — wipe the entire chain
//
// With fewer than two `providers:` entries the runtime uses the top-level
// `provider:` / `apiKey:` / `model:`; from two on it uses the chain alone, in
// array order (`createLLM`, packages/wiring). `add` therefore keeps the
// top-level provider at the head of the chain it grows. Apikeys are stored as
// `${secrets:providers/<idx>/<provider>/apiKey}` refs (a `-2`, `-3`, … suffix
// when another entry holds that name) through the SecretsResolver — never
// plaintext in config.yaml.

const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
};

const USAGE = 'Usage: ethos fallback [list | add | remove <index> | clear]';

export async function runFallback(args: string[]): Promise<void> {
  const sub = args[0] ?? 'list';
  const storage = getStorage();
  const config = await readRawConfig(storage);

  if (!config) {
    console.error(
      `${c.red}No ethos config found.${c.reset} Run ${c.bold}ethos setup${c.reset} first.`,
    );
    process.exit(1);
  }

  switch (sub) {
    case 'list':
      printList(config);
      return;
    case 'add':
      await addEntry(config);
      return;
    case 'remove': {
      const idx = Number(args[1]);
      if (!Number.isInteger(idx) || idx < 1) {
        console.error(`${c.red}remove requires a 1-based index.${c.reset} ${USAGE}`);
        process.exit(1);
      }
      await removeEntry(config, idx - 1);
      return;
    }
    case 'clear':
      await clearChain(config);
      return;
    case '--help':
    case '-h':
      console.log(USAGE);
      return;
    default:
      console.error(`${c.red}Unknown subcommand: ${sub}${c.reset}\n${USAGE}`);
      process.exit(1);
  }
}

/**
 * What the runtime runs, not how the file is laid out: with two or more chain
 * entries `createLLM` (packages/wiring) uses the chain alone, entry 1 first, and
 * ignores the top-level fields; with fewer it uses the top-level fields. One
 * "Primary" line, then the fallbacks. Chain entries keep their 1-based chain
 * number, which is what `remove <index>` takes.
 */
function printList(config: EthosConfig): void {
  const chain = config.providers ?? [];
  // Every modelled field the entry carries, plus the NAMES of the unmodelled
  // ones (`passthrough`) — their values can be anything, including something an
  // operator would not want echoed.
  const entryLine = (i: number, p: ProviderConfig, tag: string): string => {
    const extra = Object.keys(p.passthrough ?? {}).sort();
    return (
      `  ${tag}${i + 1}.${c.reset} ${c.cyan}${p.provider}${c.reset}` +
      ` · ${p.model ?? '(inherits primary model)'}` +
      ` · ${maskRef(p.apiKey)}` +
      (p.baseUrl ? ` · ${c.dim}${p.baseUrl}${c.reset}` : '') +
      (p.apiVersion ? ` · ${c.dim}apiVersion ${p.apiVersion}${c.reset}` : '') +
      (p.region ? ` · ${c.dim}region ${p.region}${c.reset}` : '') +
      (p.awsProfile ? ` · ${c.dim}profile ${p.awsProfile}${c.reset}` : '') +
      (extra.length > 0 ? ` · ${c.dim}also: ${extra.join(', ')}${c.reset}` : '')
    );
  };

  const [head, ...rest] = chain;
  if (head && rest.length > 0) {
    console.log(`${c.bold}Primary${c.reset} ${c.dim}(chain entry 1)${c.reset}`);
    console.log(entryLine(0, head, c.green));
    console.log('');
    console.log(
      `${c.bold}Fallbacks${c.reset} ${c.dim}(tried in order when the primary errors)${c.reset}`,
    );
    for (const [i, p] of rest.entries()) console.log(entryLine(i + 1, p, c.dim));
    return;
  }

  console.log(
    `${c.bold}Primary${c.reset} ${c.dim}(from top-level provider/apiKey/model)${c.reset}`,
  );
  console.log(
    `  ${c.cyan}${config.provider}${c.reset} · ${config.model} · ${maskRef(config.apiKey)}`,
  );
  console.log('');
  if (head) {
    console.log(
      `${c.dim}Not in use — a chain takes effect at two entries:${c.reset}\n${entryLine(0, head, c.dim)}`,
    );
  }
  console.log(`${c.dim}No fallback providers configured.${c.reset}`);
  console.log(`${c.dim}Add one with:${c.reset} ${c.bold}ethos fallback add${c.reset}`);
}

async function addEntry(config: EthosConfig): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log(`${c.bold}Add fallback provider${c.reset} ${c.dim}(Ctrl-C to abort)${c.reset}\n`);

    const provider = (await ask(rl, 'Provider (anthropic / openai-compat / azure): ')).trim();
    if (!provider) {
      console.error(`${c.red}Provider is required.${c.reset}`);
      return;
    }

    const apiKey = (await ask(rl, 'API key: ')).trim();
    if (!apiKey) {
      console.error(`${c.red}API key is required.${c.reset}`);
      return;
    }

    const model = (await ask(rl, 'Model (blank to inherit primary): ')).trim();
    const baseUrl = (await ask(rl, 'Base URL (blank for provider default): ')).trim();
    // Only what this provider uses, same shape as the azure line: a prompt an
    // operator cannot answer is worse than no prompt. Nothing else could author
    // `providers.<i>.region` / `.awsProfile`, so a Bedrock fallback silently ran
    // in us-east-1 (`createLLM`, packages/wiring, defaults the region).
    const apiVersion =
      provider === 'azure'
        ? (await ask(rl, 'Azure API version (e.g. 2024-12-01-preview): ')).trim()
        : '';
    const region = provider === 'bedrock' ? (await ask(rl, 'AWS region (us-east-1): ')).trim() : '';
    const awsProfile =
      provider === 'bedrock'
        ? (await ask(rl, 'AWS profile (blank for static keys / env): ')).trim()
        : '';

    const chain = [...(config.providers ?? [])];
    // Below two entries the runtime runs on the top-level fields; from two on
    // it runs the chain alone (`createLLM`, packages/wiring). So the add that
    // grows the chain past one entry must put the top-level provider at its
    // head — key reference, base URL, model and all — or the primary is gone.
    if (chain.length < 2 && config.provider) {
      const top: ProviderConfig = {
        provider: config.provider,
        apiKey: config.apiKey,
        model: config.model,
        ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
        ...(config.apiVersion ? { apiVersion: config.apiVersion } : {}),
        ...(config.region ? { region: config.region } : {}),
        ...(config.awsProfile ? { awsProfile: config.awsProfile } : {}),
      };
      const head = chain[0];
      if (head && head.provider === top.provider) chain[0] = fillFromTopLevel(head, top);
      else chain.unshift(top);
    }
    const idx = chain.length;

    // The plaintext key goes to `writeConfig`, which stores it in the vault
    // under a name no other chain entry holds (`externalizeProviderChain` in
    // @ethosagent/config) and writes only the ref. Minting
    // `providers/<idx>/<provider>/apiKey` here instead overwrote the key of any
    // survivor of an earlier `remove` that still pointed at that name.
    const secrets = await getSecretsResolver();
    const entry: ProviderConfig = {
      provider,
      apiKey,
      ...(model ? { model } : {}),
      ...(baseUrl ? { baseUrl } : {}),
      ...(apiVersion ? { apiVersion } : {}),
      ...(region ? { region } : {}),
      ...(awsProfile ? { awsProfile } : {}),
    };
    chain.push(entry);

    const next: EthosConfig = { ...config, providers: chain };
    await writeConfig(getStorage(), next, secrets);

    console.log(`\n${c.green}✓ Added fallback ${idx + 1}: ${provider}${c.reset}`);
    console.log(
      `${c.dim}Restart 'ethos gateway' (or any running daemon) to pick up the change.${c.reset}`,
    );
  } finally {
    rl.close();
  }
}

async function removeEntry(config: EthosConfig, idx: number): Promise<void> {
  const chain = [...(config.providers ?? [])];
  if (idx < 0 || idx >= chain.length) {
    console.error(`${c.red}Index out of range. The chain has ${chain.length} entries.${c.reset}`);
    process.exit(1);
  }

  const removed = chain[idx];
  if (!removed) {
    console.error(`${c.red}Internal: missing entry at index ${idx}.${c.reset}`);
    process.exit(1);
  }

  chain.splice(idx, 1);

  // Config first, vault second. The reverse order leaves config referencing
  // material that is already gone whenever the write fails; this way the worst
  // case is vault litter.
  const secrets = await getSecretsResolver();
  const next: EthosConfig = { ...config, providers: chain.length > 0 ? chain : undefined };
  await writeConfig(getStorage(), next, secrets);

  console.log(`${c.green}✓ Removed fallback ${idx + 1} (${removed.provider})${c.reset}`);

  // Cleanup of the underlying secret. The ref index doesn't shift even though
  // the array did — we intentionally don't renumber: the original ref strings
  // in the surviving entries would mis-resolve otherwise. Two entries can still
  // share one ref (an `add` from before `externalizeProviderChain` minted a
  // held name), so drop it only when no survivor still points at it.
  // Only a name the chain minted (`providers/<n>/…`) is ours to delete: a
  // canonical `providers/<provider>/apiKey` is read by name by the provider
  // factories and tools (`isProviderChainSecretRef`). And the top-level key
  // counts as a reference: `add` on a top-level-only config puts the top-level
  // entry at the head of the chain naming the SAME vault entry.
  const ref = secretRefFromValue(removed.apiKey);
  if (ref && isProviderChainSecretRef(ref) && !stillReferenced(ref, chain, config)) {
    await deleteSecretMaterial(secrets, ref);
  }
}

async function clearChain(config: EthosConfig): Promise<void> {
  const chain = config.providers ?? [];
  if (chain.length === 0) {
    console.log(`${c.dim}Chain is already empty.${c.reset}`);
    return;
  }

  // Config first, vault second — same order as `remove`.
  const secrets = await getSecretsResolver();
  const next: EthosConfig = { ...config, providers: undefined };
  await writeConfig(getStorage(), next, secrets);

  console.log(
    `${c.green}✓ Cleared ${chain.length} fallback provider${chain.length === 1 ? '' : 's'}${c.reset}`,
  );

  // Delete all underlying secrets we wrote. Deduped: two entries can hold the
  // same ref, and no entry survives the clear to keep any of them alive.
  const refs = new Set<string>();
  for (const entry of chain) {
    const ref = secretRefFromValue(entry.apiKey);
    if (ref && isProviderChainSecretRef(ref) && !stillReferenced(ref, [], config)) refs.add(ref);
  }
  for (const ref of refs) {
    await deleteSecretMaterial(secrets, ref);
  }
}

/** Whether a surviving chain entry or the top-level `apiKey` still names `ref`. */
function stillReferenced(
  ref: string,
  chain: readonly ProviderConfig[],
  config: EthosConfig,
): boolean {
  if (secretRefFromValue(config.apiKey) === ref) return true;
  return chain.some((e) => secretRefFromValue(e.apiKey) === ref);
}

/**
 * Drop one vault entry whose config reference is already gone.
 *
 * Non-fatal — config.yaml is the source of truth and is already written, so the
 * removal stands. Surfaced rather than swallowed (ARCHITECTURE.md §V S7)
 * because what is left behind is credential material, and the operator gets the
 * exact command to clean it up.
 */
async function deleteSecretMaterial(secrets: SecretsResolver, ref: string): Promise<void> {
  try {
    await secrets.delete(ref);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(
      `${c.red}⚠ Stored key material was not deleted:${c.reset} ${msg}\n` +
        `${c.dim}  Remove it with: ethos secrets remove ${ref}${c.reset}`,
    );
  }
}

function ask(rl: Interface, prompt: string): Promise<string> {
  return new Promise((resolve) => rl.question(prompt, resolve));
}

function maskRef(value: string | undefined): string {
  if (!value) return `${c.dim}(unset)${c.reset}`;
  if (value.startsWith('${secrets:')) {
    return `${c.dim}${value}${c.reset}`;
  }
  // Raw value — show only the last 4 chars.
  if (value.length <= 8) return `${c.yellow}****${c.reset} (plaintext)`;
  return `${c.yellow}****${value.slice(-4)}${c.reset}${c.dim} (plaintext — migrate to secrets resolver)${c.reset}`;
}
