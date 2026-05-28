import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
const TEMPLATE_DIR = join(import.meta.dirname, '..', '..', 'templates', 'systemd');
const TEMPLATE_NAMES = {
    'ethos-gateway': 'ethos-gateway.service.tmpl',
    'ethos-serve': 'ethos-serve.service.tmpl',
    'ethos-runall': 'ethos-runall.service.tmpl',
};
export function runSystemdUnit(argv) {
    const name = argv[0];
    if (!name || !TEMPLATE_NAMES[name]) {
        console.error(`Usage: ethos systemd-unit <name>`);
        console.error(`  Available: ${Object.keys(TEMPLATE_NAMES).join(', ')}`);
        process.exit(2);
    }
    const templateFile = TEMPLATE_NAMES[name];
    if (!templateFile) {
        console.error(`Unknown unit: ${name}`);
        process.exit(2);
    }
    const templatePath = join(TEMPLATE_DIR, templateFile);
    let template;
    try {
        template = readFileSync(templatePath, 'utf-8');
    }
    catch {
        console.error(`Template not found: ${templatePath}`);
        process.exit(1);
    }
    // Substitute placeholders from env or defaults
    const vars = {
        '{{ETHOS_BINARY}}': process.env.ETHOS_BINARY ?? 'ethos',
        '{{ETHOS_USER}}': process.env.ETHOS_USER ?? process.env.USER ?? 'ethos',
        '{{ETHOS_HOME}}': process.env.ETHOS_HOME ?? homedir(),
    };
    for (const [placeholder, value] of Object.entries(vars)) {
        if (/[\r\n]/.test(value)) {
            console.error(`Invalid value for ${placeholder}: must not contain newlines`);
            process.exit(2);
        }
    }
    let output = template;
    for (const [placeholder, value] of Object.entries(vars)) {
        output = output.replaceAll(placeholder, value);
    }
    process.stdout.write(output);
}
