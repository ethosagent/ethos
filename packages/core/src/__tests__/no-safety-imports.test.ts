import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function collectTsFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      results.push(...collectTsFiles(full));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      results.push(full);
    }
  }
  return results;
}

describe('Law 2 — no runtime safety imports in core src', () => {
  const coreDir = join(import.meta.dirname, '..');
  const files = collectTsFiles(coreDir);

  it('forbids runtime value imports from safety packages', () => {
    const violations: string[] = [];
    const forbidden = [
      /from\s+['"]@ethosagent\/safety-injection['"]/,
      /from\s+['"]@ethosagent\/safety-network['"]/,
      /from\s+['"]@ethosagent\/safety-redact['"]/,
      /from\s+['"]@ethosagent\/storage-fs['"]/,
    ];
    for (const file of files) {
      const content = readFileSync(file, 'utf-8');
      for (const pattern of forbidden) {
        const match = content.match(pattern);
        if (match) {
          const line = content.split('\n').find((l) => pattern.test(l));
          if (line && !line.trimStart().startsWith('import type')) {
            violations.push(`${file}: ${match[0]}`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
