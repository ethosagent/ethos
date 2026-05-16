import { join } from 'node:path';
import { ethosDir } from '../config';
import { getSecretsResolver } from '../wiring';

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

export async function runSecrets(args: string[]): Promise<void> {
  const sub = args[0] ?? 'list';
  const resolver = getSecretsResolver();

  switch (sub) {
    case 'list': {
      const prefix = args[1];
      const refs = await resolver.list(prefix);
      if (refs.length === 0) {
        console.log(`\n${c.dim}No secrets stored.${c.reset}`);
        console.log(`${c.dim}Add one with: ${c.reset}ethos secrets set <ref> <value>\n`);
        return;
      }
      console.log();
      console.log(`${c.bold}Secrets${c.reset}  ${c.dim}(~/.ethos/secrets/)${c.reset}`);
      for (const ref of refs.sort()) {
        const val = await resolver.get(ref);
        const masked = val ? maskValue(val) : `${c.red}(empty)${c.reset}`;
        console.log(`  ${c.cyan}${ref}${c.reset}  ${masked}`);
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
      const ref = args[1];
      if (!ref) {
        console.log('Usage: ethos secrets get <ref>');
        process.exit(1);
      }
      const value = await resolver.get(ref);
      if (value === null) {
        console.log(`${c.red}Secret not found: ${ref}${c.reset}`);
        process.exit(1);
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

    case 'path': {
      console.log(join(ethosDir(), 'secrets'));
      break;
    }

    default:
      console.log(
        'Usage: ethos secrets [list | set <ref> <value> | get <ref> | remove <ref> | path]',
      );
  }
}
