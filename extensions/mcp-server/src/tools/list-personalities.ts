import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface PersonalitySummary {
  id: string;
  name: string;
  description: string;
  model?: string;
  tools: string[];
}

function parseYamlValue(yaml: string, key: string): string | undefined {
  const match = yaml.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
  return match?.[1]?.trim().replace(/^["']|["']$/g, '');
}

function loadPersonalitiesFromDir(dir: string, ids: Set<string>): PersonalitySummary[] {
  if (!existsSync(dir)) return [];
  const results: PersonalitySummary[] = [];

  for (const sub of readdirSync(dir)) {
    if (ids.has(sub)) continue;
    const cfgPath = join(dir, sub, 'config.yaml');
    const toolsetPath = join(dir, sub, 'toolset.yaml');
    if (!existsSync(cfgPath)) continue;

    const cfg = readFileSync(cfgPath, 'utf8');
    const name = parseYamlValue(cfg, 'name') ?? sub;
    const description = parseYamlValue(cfg, 'description') ?? '';
    const model = parseYamlValue(cfg, 'model');

    let tools: string[] = [];
    if (existsSync(toolsetPath)) {
      tools = readFileSync(toolsetPath, 'utf8')
        .split('\n')
        .map((l) => l.replace(/^-\s*/, '').trim())
        .filter(Boolean);
    }

    ids.add(sub);
    results.push({ id: sub, name, description, model, tools });
  }

  return results;
}

export function listPersonalities(dataDir: string): PersonalitySummary[] {
  // Built-in personalities ship inside the extension; user personalities live in ~/.ethos/personalities/
  const builtinDir = join(
    new URL('../../..', import.meta.url).pathname,
    'extensions',
    'personalities',
    'data',
  );
  const userDir = join(dataDir, 'personalities');
  const seen = new Set<string>();

  return [
    ...loadPersonalitiesFromDir(builtinDir, seen),
    ...loadPersonalitiesFromDir(userDir, seen),
  ];
}

export const listPersonalitiesToolDef = {
  name: 'list_personalities',
  description:
    'List all available Ethos personalities with their IDs, descriptions, and allowed tools.',
  inputSchema: {
    type: 'object' as const,
    properties: {},
    required: [],
  },
};
