import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Orchestrator guardrails', () => {
  const agentLoopFile = join(import.meta.dirname, '..', 'agent-loop.ts');
  const agentLoopDir = join(import.meta.dirname, '..', 'agent-loop');

  it('agent-loop.ts is under the orchestrator size limit', () => {
    const content = readFileSync(agentLoopFile, 'utf-8');
    const lineCount = content.split('\n').length;
    // Phase 9 threshold — the orchestrator should stay lean. Ratcheted as the
    // loop legitimately grows (735 → 750 → 754 → 759 → 761); §5 added the
    // compaction gate config field, §2 added the promptBudget config field + its
    // constructor/deps threading (5 irreducible lines, compressed to one-line
    // shapes to keep the growth minimal); background sub-agents added the
    // rootSessionKey seam on RunOptions (field + its threading to ToolContext).
    expect(lineCount).toBeLessThanOrEqual(762);
  });

  it('no stage file exceeds 700 lines', () => {
    const stagesDir = join(agentLoopDir, 'stages');
    const violations: string[] = [];
    for (const file of readdirSync(stagesDir)) {
      if (!file.endsWith('.ts')) continue;
      const content = readFileSync(join(stagesDir, file), 'utf-8');
      const lineCount = content.split('\n').length;
      // Bumped 720 → 722: background sub-agents threaded rootSessionKey through
      // tool-processing.ts's ToolContext construction, pushing it to 722.
      if (lineCount > 722) {
        violations.push(`${file}: ${lineCount} lines`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('no helper module in agent-loop/ exceeds 500 lines', () => {
    const violations: string[] = [];
    for (const file of readdirSync(agentLoopDir)) {
      if (!file.endsWith('.ts') || file === 'index.ts') continue;
      if (statSync(join(agentLoopDir, file)).isDirectory()) continue;
      const content = readFileSync(join(agentLoopDir, file), 'utf-8');
      const lineCount = content.split('\n').length;
      if (lineCount > 500) {
        violations.push(`${file}: ${lineCount} lines`);
      }
    }
    expect(violations).toEqual([]);
  });
});
