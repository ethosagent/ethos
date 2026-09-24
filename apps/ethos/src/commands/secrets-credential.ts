// `ethos secrets credential add|list|rm|grant|revoke` — stored logins for
// `browser_fill_credential` (plan reach-and-containment §4.2).
//
// Values are PROMPTED, never taken as arguments, so they do not land in shell
// history or `ps`. The password and TOTP seed are read without echo. Nothing
// here prints a value: `list` shows a masked username preview
// (`redactSecretValue`) and whether a TOTP seed is set. Validation and the
// vault layout are owned by `extensions/tools-browser/src/credential-vault.ts`
// (reached through `@ethosagent/wiring`), the same code `CredentialsService`
// writes through and the tool reads back.

import { Writable } from 'node:stream';
import type { SecretsResolver } from '@ethosagent/types';
import {
  CredentialValidationError,
  deleteCredential,
  listCredentials,
  setCredential,
  updateCredentialPolicy,
} from '@ethosagent/wiring';
import { writeJson } from '../json-output';

const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  red: '\x1b[31m',
};

export type CredentialPrompt = (question: string, opts: { hidden: boolean }) => Promise<string>;

export interface SecretsCredentialDeps {
  secrets: SecretsResolver;
  prompt?: CredentialPrompt;
}

const USAGE = [
  'Usage: ethos secrets credential <command>',
  '  add <name> --origin <origin> [--origin …] [--personality <id> …] [--unattended]',
  '  list [--json]',
  '  rm <name>',
  '  grant <name> [--personality <id> …] [--unattended]',
  '  revoke <name> [--personality <id> …] [--unattended]',
].join('\n');

/** Every value of a repeatable `--flag v` / `--flag=v`. */
function flagValues(args: string[], flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? '';
    if (a === flag) {
      const v = args[i + 1];
      if (v !== undefined && !v.startsWith('--')) out.push(v);
      i++;
    } else if (a.startsWith(`${flag}=`)) {
      out.push(a.slice(flag.length + 1));
    }
  }
  return out;
}

function positional(args: string[]): string | undefined {
  const valueFlags = new Set(['--origin', '--personality']);
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? '';
    if (valueFlags.has(a)) {
      i++;
      continue;
    }
    if (!a.startsWith('--')) return a;
  }
  return undefined;
}

function fail(message: string, hint?: string): void {
  console.log(`${c.red}✗ ${message}${c.reset}`);
  if (hint) console.log(`${c.dim}  ${hint}${c.reset}`);
  process.exitCode = 1;
}

export async function runSecretsCredential(
  args: string[],
  deps: SecretsCredentialDeps,
): Promise<void> {
  const sub = args[0];
  const rest = args.slice(1);
  try {
    switch (sub) {
      case 'add':
        return await add(rest, deps);
      case 'list':
        return await list(rest, deps);
      case 'rm':
        return await rm(rest, deps);
      case 'grant':
      case 'revoke':
        return await amend(sub, rest, deps);
      default:
        console.log(USAGE);
        if (sub !== undefined) process.exitCode = 1;
    }
  } catch (err) {
    if (err instanceof CredentialValidationError) return fail(err.message, err.hint);
    throw err;
  }
}

async function add(args: string[], deps: SecretsCredentialDeps): Promise<void> {
  const name = positional(args);
  if (!name) return fail('add needs a credential name.', USAGE);
  const origins = flagValues(args, '--origin');
  const personalities = flagValues(args, '--personality');
  const prompt = deps.prompt ?? createTtyPrompt();

  const username = await prompt('Username: ', { hidden: false });
  const password = await prompt('Password (hidden): ', { hidden: true });
  const totp = await prompt('TOTP seed or otpauth:// URI (hidden, blank for none): ', {
    hidden: true,
  });

  const { policy } = await setCredential(deps.secrets, {
    name,
    username,
    password,
    totp: totp.trim() === '' ? null : totp,
    origins,
    personalities,
    unattended: args.includes('--unattended'),
  });
  console.log(`${c.green}✓ Credential stored${c.reset}  ${c.cyan}${name}${c.reset}`);
  console.log(`  origins        ${policy.origins.join(', ')}`);
  console.log(
    `  personalities  ${policy.personalities.length > 0 ? policy.personalities.join(', ') : `${c.dim}(none — usable by nobody until granted)${c.reset}`}`,
  );
  console.log(`  unattended     ${policy.unattended ? 'yes' : 'no'}`);
}

async function list(args: string[], deps: SecretsCredentialDeps): Promise<void> {
  const rows = await listCredentials(deps.secrets);
  if (args.includes('--json')) {
    writeJson(rows);
    return;
  }
  if (rows.length === 0) {
    console.log(`\n${c.dim}No stored logins.${c.reset}`);
    console.log(
      `${c.dim}Add one with: ${c.reset}ethos secrets credential add <name> --origin https://… --personality <id>\n`,
    );
    return;
  }
  console.log();
  console.log(`${c.bold}Logins${c.reset}  ${c.dim}(browser_fill_credential)${c.reset}`);
  for (const r of rows) {
    console.log(
      `  ${c.cyan}${r.name}${c.reset}${r.policyValid ? '' : `  ${c.red}(invalid policy)${c.reset}`}`,
    );
    console.log(`    origins        ${r.origins.join(', ') || '-'}`);
    console.log(`    personalities  ${r.personalities.join(', ') || '-'}`);
    console.log(`    username       ${r.usernamePreview}`);
    console.log(`    totp           ${r.hasTotp ? 'yes' : 'no'}`);
    console.log(`    unattended     ${r.unattended ? 'yes' : 'no'}`);
  }
  console.log();
}

async function rm(args: string[], deps: SecretsCredentialDeps): Promise<void> {
  const name = positional(args);
  if (!name) return fail('rm needs a credential name.', USAGE);
  await deleteCredential(deps.secrets, name);
  console.log(`${c.green}✓ Removed${c.reset}  ${c.cyan}${name}${c.reset}`);
}

async function amend(
  mode: 'grant' | 'revoke',
  args: string[],
  deps: SecretsCredentialDeps,
): Promise<void> {
  const name = positional(args);
  if (!name) return fail(`${mode} needs a credential name.`, USAGE);
  const personalities = flagValues(args, '--personality');
  const unattended = args.includes('--unattended');
  if (personalities.length === 0 && !unattended) {
    return fail(`${mode} needs --personality <id> and/or --unattended.`, USAGE);
  }
  const policy = await updateCredentialPolicy(deps.secrets, name, (p) => ({
    ...p,
    personalities:
      mode === 'grant'
        ? [...p.personalities, ...personalities]
        : p.personalities.filter((id) => !personalities.includes(id)),
    unattended: unattended ? mode === 'grant' : p.unattended,
  }));
  console.log(
    `${c.green}✓ ${mode === 'grant' ? 'Granted' : 'Revoked'}${c.reset}  ${c.cyan}${name}${c.reset}  personalities: ${policy.personalities.join(', ') || '(none)'} · unattended: ${policy.unattended ? 'yes' : 'no'}`,
  );
}

/**
 * Prompt on the terminal, muting echo for hidden answers. On a non-TTY stdin
 * (a pipe, a script) every line is read up front and handed out in order —
 * one readline per question would drop lines that arrived before it opened.
 */
function createTtyPrompt(): CredentialPrompt {
  if (!process.stdin.isTTY) {
    let lines: Promise<string[]> | undefined;
    let next = 0;
    return async (question) => {
      lines ??= new Promise((resolve, reject) => {
        let buf = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', (d) => {
          buf += d;
        });
        process.stdin.on('end', () => resolve(buf.split(/\r?\n/)));
        process.stdin.on('error', reject);
      });
      process.stdout.write(`${question}\n`);
      return (await lines)[next++] ?? '';
    };
  }
  return async (question, { hidden }) => {
    const { createInterface } = await import('node:readline');
    let muted = false;
    const out = new Writable({
      write(chunk, _enc, cb) {
        if (!muted) process.stdout.write(chunk);
        cb();
      },
    });
    const rl = createInterface({ input: process.stdin, output: out, terminal: true });
    return new Promise<string>((resolve) => {
      rl.question(question, (answer) => {
        rl.close();
        if (hidden) process.stdout.write('\n');
        resolve(answer);
      });
      muted = hidden;
    });
  };
}
