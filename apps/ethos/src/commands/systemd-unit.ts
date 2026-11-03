import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { splitJson, writeJson, writeJsonError } from '../json-output';

const TEMPLATE_DIR = join(import.meta.dirname, '..', '..', 'templates', 'systemd');

const TEMPLATE_NAMES: Record<string, string> = {
  'ethos-gateway': 'ethos-gateway.service.tmpl',
  'ethos-serve': 'ethos-serve.service.tmpl',
  'ethos-runall': 'ethos-runall.service.tmpl',
};

export function runSystemdUnit(args: string[]): void {
  const { json, args: argv } = splitJson(args);
  const name = argv[0];
  if (!name || !TEMPLATE_NAMES[name]) {
    if (json) {
      writeJsonError(
        'INVALID_INPUT',
        `Usage: ethos systemd-unit <name> [--json]. Available: ${Object.keys(TEMPLATE_NAMES).join(', ')}`,
        2,
      );
    }
    console.error(`Usage: ethos systemd-unit <name> [--json]`);
    console.error(`  Available: ${Object.keys(TEMPLATE_NAMES).join(', ')}`);
    process.exit(2);
  }

  const templateFile = TEMPLATE_NAMES[name];
  if (!templateFile) {
    console.error(`Unknown unit: ${name}`);
    process.exit(2);
  }
  const templatePath = join(TEMPLATE_DIR, templateFile);
  let template: string;
  try {
    template = readFileSync(templatePath, 'utf-8');
  } catch {
    if (json) writeJsonError('FILE_NOT_FOUND', `Template not found: ${templatePath}`);
    console.error(`Template not found: ${templatePath}`);
    process.exit(1);
  }

  // Substitute placeholders from env or defaults
  const vars: Record<string, string> = {
    '{{ETHOS_BINARY}}': process.env.ETHOS_BINARY ?? 'ethos',
    '{{ETHOS_USER}}': process.env.ETHOS_USER ?? process.env.USER ?? 'ethos',
    '{{ETHOS_HOME}}': process.env.ETHOS_HOME ?? homedir(),
  };

  for (const [placeholder, value] of Object.entries(vars)) {
    if (/[\r\n]/.test(value)) {
      if (json) {
        writeJsonError(
          'INVALID_INPUT',
          `Invalid value for ${placeholder}: must not contain newlines`,
          2,
        );
      }
      console.error(`Invalid value for ${placeholder}: must not contain newlines`);
      process.exit(2);
    }
  }

  let output = template;
  for (const [placeholder, value] of Object.entries(vars)) {
    output = output.replaceAll(placeholder, value);
  }

  if (json) {
    writeJson({ ok: true, name, content: output });
    return;
  }
  process.stdout.write(output);
}
