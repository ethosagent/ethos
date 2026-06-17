// `ethos personality evolve <id>` / `ethos personality revert <id>` (Phase 3a).
//
// Governed learning for a personality's Living Soul Expression. `evolve` gathers
// recent session evidence, drafts an Expression update via the LLM, shows the
// diff + rationale, and applies it only after explicit user approval. `revert`
// undoes the most recent Expression update.
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { draftExpressionUpdate } from '@ethosagent/skill-evolver';
import { formatError, toEthosError } from '@ethosagent/types';
import { createLLM, getStorage } from '../wiring';

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await rl.question(question);
    return answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes';
  } finally {
    rl.close();
  }
}

function oneLine(content: string): string {
  const collapsed = content.replace(/\s+/g, ' ').trim();
  return collapsed.length > 400 ? `${collapsed.slice(0, 400)}…` : collapsed;
}

function surface(err: unknown): never {
  process.stderr.write(`\n${formatError(toEthosError(err), { color: process.stderr.isTTY })}\n`);
  process.exit(1);
}

export async function runPersonalityEvolve(argv: string[]): Promise<void> {
  const id = argv.find((a) => !a.startsWith('-'));
  if (!id) {
    console.log('Usage: ethos personality evolve <id>');
    return;
  }

  try {
    const { createPersonalityRegistry } = await import('@ethosagent/personalities');
    const { ethosDir, readConfig } = await import('../config');
    const { join } = await import('node:path');
    const { getSecretsResolver } = await import('../wiring');

    const storage = getStorage();
    const reg = await createPersonalityRegistry({ storage, userPersonalitiesDir: ethosDir() });
    await reg.loadFromDirectory(join(ethosDir(), 'personalities'));

    const described = reg.describe(id);
    if (!described) {
      console.error(`Unknown personality: ${id}`);
      console.error('Run `ethos personality list` to see available ids.');
      process.exit(1);
    }

    const config = await readConfig(getStorage(), await getSecretsResolver());
    if (!config) {
      console.error('Run `ethos setup` first.');
      process.exit(1);
    }

    if (described.config.evolution_approval_mode === 'auto') {
      console.log('Note: auto-approval mode is deferred to phase-3b; this MVP uses user approval.');
    }

    // Gather recent session evidence, newest-first, capped at 20 messages / 4000 chars.
    const { SQLiteSessionStore } = await import('@ethosagent/session-sqlite');
    const { join: pathJoin } = await import('node:path');
    const store = new SQLiteSessionStore(pathJoin(ethosDir(), 'sessions.db'));

    let scopedNote = '';
    const digestLines: string[] = [];
    let totalChars = 0;
    const MAX_MSGS = 20;
    const MAX_CHARS = 4000;
    try {
      let sessions = await store.listSessions({ personalityId: id });
      if (sessions.length === 0) {
        sessions = await store.listSessions();
        scopedNote =
          'evidence drawn from recent sessions across all personalities (none recorded for this personality yet)';
      }
      if (sessions.length === 0) {
        console.log(
          'No recent session evidence yet — interact with this personality first, then evolve.',
        );
        return;
      }
      sessions.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());

      let capped = false;
      for (const s of sessions) {
        if (capped) break;
        const msgs = await store.getMessages(s.id, { limit: 20 });
        for (let i = msgs.length - 1; i >= 0; i--) {
          const m = msgs[i];
          if (!m) continue;
          if (m.role !== 'user' && m.role !== 'assistant') continue;
          const line = `${m.role}: ${oneLine(m.content)}`;
          if (digestLines.length >= MAX_MSGS || totalChars + line.length > MAX_CHARS) {
            digestLines.push('… [evidence truncated]');
            capped = true;
            break;
          }
          digestLines.push(line);
          totalChars += line.length;
        }
      }
    } finally {
      store.close();
    }

    const evidence = digestLines.join('\n');

    const soul = await reg.readLivingSoul(id);
    const llm = await createLLM(config);
    const draft = await draftExpressionUpdate(
      { core: soul.core, currentExpression: soul.expression, evidence },
      llm,
    );

    if (scopedNote) {
      console.log(scopedNote);
    }
    console.log('=== Evidence (recent interactions) ===');
    console.log(evidence);
    console.log('=== Rationale ===');
    console.log(draft.rationale || '(no rationale provided)');
    console.log('=== Proposed Expression change ===');
    if (soul.expression.trim() === '') {
      console.log(
        'This soul has no Expression region yet; this will create one (Core stays untouched).',
      );
      console.log(draft.newExpression);
    } else {
      const { unifiedDiff } = await import('../index');
      console.log(
        unifiedDiff(
          soul.expression,
          draft.newExpression,
          'expression (current)',
          'expression (proposed)',
        ),
      );
    }

    const ok = await confirm('Apply this Expression update? [y/N] ');
    if (!ok) {
      console.log('Aborted — no changes.');
      return;
    }

    const { entry } = await reg.evolveExpression(id, draft.newExpression, {
      summary: draft.rationale.slice(0, 120) || 'expression update',
      evidenceRef: `sessions:${new Date().toISOString()}`,
    });
    console.log(`✓ Expression updated (revision ${entry.revisionId}).`);
    console.log('Undo with `ethos personality revert <id>`.');
  } catch (err) {
    surface(err);
  }
}

export async function runPersonalityRevert(argv: string[]): Promise<void> {
  const id = argv.find((a) => !a.startsWith('-'));
  if (!id) {
    console.log('Usage: ethos personality revert <id>');
    return;
  }

  try {
    const { createPersonalityRegistry } = await import('@ethosagent/personalities');
    const { ethosDir } = await import('../config');
    const { join } = await import('node:path');

    const storage = getStorage();
    const reg = await createPersonalityRegistry({ storage, userPersonalitiesDir: ethosDir() });
    await reg.loadFromDirectory(join(ethosDir(), 'personalities'));

    const described = reg.describe(id);
    if (!described) {
      console.error(`Unknown personality: ${id}`);
      console.error('Run `ethos personality list` to see available ids.');
      process.exit(1);
    }

    const soul = await reg.readLivingSoul(id);
    if (soul.learningLog.length === 0) {
      console.log('Nothing to revert.');
      return;
    }
    const last = soul.learningLog[soul.learningLog.length - 1];
    if (!last) {
      console.log('Nothing to revert.');
      return;
    }

    console.log(
      `This will restore the Expression snapshot from before: "${last.summary}" (revision ${last.revisionId}).`,
    );
    console.log(`Restoring snapshot: ${last.prevExpressionRef}`);

    const ok = await confirm('Revert to that snapshot? [y/N] ');
    if (!ok) {
      console.log('Aborted.');
      return;
    }

    await reg.revertExpression(id, last.prevExpressionRef);
    console.log(`✓ Reverted "${id}" to snapshot ${last.prevExpressionRef}.`);
  } catch (err) {
    surface(err);
  }
}
