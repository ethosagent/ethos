import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { ethosDir } from '@ethosagent/config';
import { EnvSecretsResolver } from '@ethosagent/storage-fs';
import type { SecretsResolver } from '@ethosagent/types';
import { writeJson } from '../json-output';
import { getSecretsResolver } from '../wiring';
import { runSecretsCredential } from './secrets-credential';

const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
};

function maskValue(value: string): string {
  if (value.length <= 8) return '***';
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

/**
 * B8 — which reader would actually serve `ref`. The merged resolver reads env
 * before the file vault (`MergedSecretsResolver` in wiring), so an env var
 * recognised for this ref silently outranks a stored value; the list column
 * makes that precedence visible. Exported for `secrets-list-source.test.ts`.
 */
export async function secretSource(
  ref: string,
  envReader: SecretsResolver = new EnvSecretsResolver(),
): Promise<'env' | 'vault'> {
  return (await envReader.get(ref)) !== null ? 'env' : 'vault';
}

/**
 * B8 — whether `secrets get` may print the plaintext. `--reveal` always may,
 * and so does `--json`: asking for machine-readable output IS the explicit
 * statement that a consumer wants the value (a y/N prompt inside a JSON
 * stream would corrupt it, and refusing would break every script that pipes
 * `--json`). A TTY without either asks first; a plain non-TTY without either
 * refuses (a script that wants the value states so explicitly). Exported for
 * the test.
 */
export function revealDecision(opts: {
  reveal: boolean;
  isTTY: boolean;
  json?: boolean;
}): 'yes' | 'confirm' | 'refuse' {
  if (opts.reveal || opts.json) return 'yes';
  return opts.isTTY ? 'confirm' : 'refuse';
}

async function confirmReveal(ref: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`Print the plaintext value of ${ref}? [y/N] `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y');
    });
  });
}

export async function runSecrets(args: string[]): Promise<void> {
  const sub = args[0] ?? 'list';
  const resolver = await getSecretsResolver();
  const json = args.includes('--json');

  switch (sub) {
    case 'list': {
      const prefix = args[1] && !args[1].startsWith('--') ? args[1] : undefined;
      const refs = await resolver.list(prefix);
      if (json) {
        const result: Array<{ ref: string; masked: string; source: 'env' | 'vault' }> = [];
        for (const ref of refs.sort()) {
          const val = await resolver.get(ref);
          result.push({
            ref,
            masked: val ? maskValue(val) : '(empty)',
            source: await secretSource(ref),
          });
        }
        writeJson(result);
        return;
      }
      if (refs.length === 0) {
        console.log(`\n${c.dim}No secrets stored.${c.reset}`);
        console.log(`${c.dim}Add one with: ${c.reset}ethos secrets set <ref> <value>\n`);
        return;
      }
      console.log();
      console.log(
        `${c.bold}Secrets${c.reset}  ${c.dim}(~/.ethos/secrets/; env entries outrank the vault)${c.reset}`,
      );
      for (const ref of refs.sort()) {
        const val = await resolver.get(ref);
        const masked = val ? maskValue(val) : `${c.red}(empty)${c.reset}`;
        const source = await secretSource(ref);
        const sourceCol =
          source === 'env' ? `${c.yellow}env${c.reset}  ` : `${c.dim}vault${c.reset}`;
        console.log(`  ${sourceCol}  ${c.cyan}${ref}${c.reset}  ${masked}`);
      }
      console.log();
      break;
    }

    case 'set': {
      const ref = args[1];
      const value = args[2];
      if (!ref || !value) {
        console.log('Usage: ethos secrets set <ref> <value>');
        console.log(
          `${c.dim}Example: ethos secrets set providers/anthropic/apiKey sk-ant-...${c.reset}`,
        );
        process.exit(1);
      }
      await resolver.set(ref, value);
      console.log(
        `${c.green}✓ Secret set${c.reset}  ${c.cyan}${ref}${c.reset}  ${maskValue(value)}`,
      );
      break;
    }

    case 'get': {
      const ref = args.slice(1).find((a) => !a.startsWith('--'));
      const reveal = args.includes('--reveal');
      if (!ref) {
        console.log('Usage: ethos secrets get <ref> [--reveal]');
        process.exit(1);
      }
      const value = await resolver.get(ref);
      if (value === null) {
        if (json) {
          writeJson({ ref, value: null });
          return;
        }
        console.log(`${c.red}Secret not found: ${ref}${c.reset}`);
        process.exit(1);
      }
      // B8 — plaintext only with --reveal, --json, or an explicit TTY
      // confirmation.
      const decision = revealDecision({ reveal, isTTY: Boolean(process.stdin.isTTY), json });
      if (decision === 'refuse') {
        console.error(
          `Refusing to print ${ref} without confirmation. Re-run with: ethos secrets get ${ref} --reveal`,
        );
        process.exit(1);
      }
      if (decision === 'confirm' && !(await confirmReveal(ref))) {
        console.log('Cancelled.');
        return;
      }
      if (json) {
        writeJson({ ref, value });
        return;
      }
      console.log(value);
      break;
    }

    case 'remove': {
      const ref = args[1];
      if (!ref) {
        console.log('Usage: ethos secrets remove <ref>');
        process.exit(1);
      }
      await resolver.delete(ref);
      console.log(`${c.green}✓ Removed${c.reset}  ${c.cyan}${ref}${c.reset}`);
      break;
    }

    case 'credential': {
      await runSecretsCredential(args.slice(1), { secrets: resolver });
      break;
    }

    case 'path': {
      console.log(join(ethosDir(), 'secrets'));
      break;
    }

    default:
      console.log(
        'Usage: ethos secrets [list | set <ref> <value> | get <ref> [--reveal] | remove <ref> | credential <add|list|rm|grant|revoke> | path]',
      );
  }
}
