// The eval-driven skill evolver (path 7 in plan `trust-before-reach.md`
// Part 4): `ethos evolve run`, `ethos evolve --eval-output`, `ethos eval
// --evolve`, and the `skill-evolver` system job.
//
// It drafts rewrites of low-scoring skills and new skills from high-scoring
// skill-less bundles, and SUBMITS each draft to the learning inbox. It used to
// write `skills/pending/`, which `--auto-approve` then renamed straight into the
// live dir. Nothing here promotes now; `--auto-approve` replays the candidates
// and lets `replayAndResolve` decide (L-D9).

import { join } from 'node:path';
import { checkSkillFrontmatter } from '@ethosagent/skills';
import type { LLMProvider, Message, PersonalityConfig, Storage } from '@ethosagent/types';
import { analyzeEvalOutput, parseEvalJsonl } from './analyze';
import type { LearningSubmitPort } from './learning-port';
import {
  parseNewSkillResponse,
  parseRewriteResponse,
  renderNewSkillPrompt,
  renderRewritePrompt,
} from './prompts';
import { liveSkillDir } from './skill-dir';
import type { EvolutionPlan, EvolveConfig, TaskSummary } from './types';

export interface EvolveOptions {
  evalOutputPath: string;
  /** The skills the evaluated run used — analysed for rewrite candidates. */
  skillsDir: string;
  config: EvolveConfig;
  llm: LLMProvider;
  /** Storage backend. Injected by the composition root; required — never
   *  falls back to raw disk. */
  storage: Storage;
  /**
   * Improve existing skills (the rewrite branch). Defaults to `true`. `false`
   * skips rewrites while still creating new skills. The personality's
   * `skill_evolution.evolve_existing`, mapped by `skillEvolutionEvolveOptions`.
   */
  evolveExisting?: boolean;
  /**
   * Model id every drafting call is routed to, sent as `modelOverride` on the
   * injected provider. Unset = the provider's own model. The personality's
   * `skill_evolution.model`, mapped by `skillEvolutionEvolveOptions`.
   */
  model?: string;
  /** The learning inbox every draft is submitted to. */
  learning: LearningSubmitPort;
  /** `~/.ethos` — the root `liveSkillDir` resolves destinations under. */
  dataDir: string;
  /** The personality the evaluated run belonged to. */
  personalityId: string;
  /** That personality's `skill_evolution.scope`. */
  scope?: 'personality' | 'shared';
  /**
   * Freeze target cases from the tasks a draft was made from and return their
   * ids. `ethos eval --evolve` has the authored expected values for this; a
   * caller without them omits it, and the candidate replays `incomplete` and
   * waits for a human.
   */
  targetCaseIds?: (tasks: TaskSummary[]) => Promise<string[]>;
}

export interface EvolveResult {
  plan: EvolutionPlan;
  /** Filenames of the rewrites submitted to the inbox. */
  rewritesSubmitted: string[];
  /** Filenames of the new skills submitted to the inbox. */
  newSkillsSubmitted: string[];
  /** Inbox candidate ids, in submission order. */
  candidateIds: string[];
  skipped: Array<{ kind: 'rewrite' | 'new'; target: string; reason: string }>;
}

/**
 * The one mapping from a personality's `skill_evolution` block onto the
 * evolver's options, shared by `ethos evolve` (and `evolve run`) and `ethos eval
 * --evolve`. An absent key contributes nothing, so the evolver's own default
 * applies (`evolveExisting` = `true`, model = the provider's).
 */
export function skillEvolutionEvolveOptions(
  cfg: PersonalityConfig['skill_evolution'],
): Pick<EvolveOptions, 'scope' | 'evolveExisting' | 'model'> {
  return {
    ...(cfg?.scope !== undefined ? { scope: cfg.scope } : {}),
    ...(cfg?.evolve_existing !== undefined ? { evolveExisting: cfg.evolve_existing } : {}),
    ...(cfg?.model ? { model: cfg.model } : {}),
  };
}

export class SkillEvolver {
  constructor(private readonly options: EvolveOptions) {}

  async evolve(): Promise<EvolveResult> {
    const { evalOutputPath, skillsDir, config, llm, learning, personalityId } = this.options;
    const storage = this.options.storage;
    const evolveExisting = this.options.evolveExisting ?? true;
    const liveDir = liveSkillDir(this.options.dataDir, personalityId, this.options.scope);

    const src = await storage.read(evalOutputPath);
    if (!src) throw new Error(`eval output not found: ${evalOutputPath}`);
    const records = parseEvalJsonl(src);
    const plan = await analyzeEvalOutput(records, skillsDir, config, storage);

    const rewritesSubmitted: string[] = [];
    const newSkillsSubmitted: string[] = [];
    const candidateIds: string[] = [];
    const skipped: EvolveResult['skipped'] = [];

    const submit = async (
      op: 'create' | 'rewrite',
      fileName: string,
      content: string,
      tasks: TaskSummary[],
    ): Promise<void> => {
      let targetCaseIds: string[] = [];
      try {
        targetCaseIds = (await this.options.targetCaseIds?.(tasks)) ?? [];
      } catch {
        targetCaseIds = [];
      }
      const candidate = await learning.submit({
        kind: 'skill',
        op,
        personalityId,
        origin: 'eval',
        destination: join(liveDir, fileName),
        content,
        evidence: {
          taskIds: tasks.map((t) => t.taskId),
          ref: `eval:${evalOutputPath}`,
        },
        targetCaseIds,
      });
      candidateIds.push(candidate.id);
    };

    const rewriteCandidates = evolveExisting ? plan.rewriteCandidates : [];
    for (const candidate of rewriteCandidates) {
      const prompt = renderRewritePrompt(candidate);
      const raw = await callLLM(llm, prompt, this.options.model);
      const parsed = parseRewriteResponse(raw);
      if (parsed.kind === 'skip') {
        skipped.push({ kind: 'rewrite', target: candidate.fileName, reason: parsed.reason });
        continue;
      }
      const outName = candidate.fileName;
      const check = checkSkillFrontmatter(parsed.content);
      if (!check.ok) {
        skipped.push({
          kind: 'rewrite',
          target: outName,
          reason: `invalid-frontmatter: ${check.error}`,
        });
        continue;
      }
      await submit(
        'rewrite',
        outName,
        `${withTargetFile(parsed.content, outName)}\n`,
        candidate.lowScoringTasks,
      );
      rewritesSubmitted.push(outName);
    }

    for (const candidate of plan.newSkillCandidates) {
      const prompt = renderNewSkillPrompt(candidate);
      const raw = await callLLM(llm, prompt, this.options.model);
      const parsed = parseNewSkillResponse(raw);
      if (parsed.kind === 'skip') {
        skipped.push({ kind: 'new', target: 'pattern-bundle', reason: parsed.reason });
        continue;
      }
      const check = checkSkillFrontmatter(parsed.content);
      if (!check.ok) {
        skipped.push({
          kind: 'new',
          target: parsed.fileName,
          reason: `invalid-frontmatter: ${check.error}`,
        });
        continue;
      }
      const safeName = await pickAvailableName(parsed.fileName, [skillsDir, liveDir], storage);
      await submit('create', safeName, `${parsed.content}\n`, candidate.tasks);
      newSkillsSubmitted.push(safeName);
    }

    return { plan, rewritesSubmitted, newSkillsSubmitted, candidateIds, skipped };
  }
}

/**
 * A rewrite is applied to the file it rewrites: `promote()` reads the
 * content's `target_file` to find it (`skillFilename` in
 * `extensions/learning-inbox/src/promote.ts`). The rewrite prompt returns a
 * bare skill, so the key is stamped here — into the existing frontmatter when
 * there is one, otherwise as a frontmatter block of its own.
 */
function withTargetFile(content: string, fileName: string): string {
  const line = `target_file: ${fileName}`;
  if (/^---\r?\n/.test(content)) return content.replace(/^---\r?\n/, `---\n${line}\n`);
  return `---\n${line}\n---\n\n${content}`;
}

async function callLLM(llm: LLMProvider, prompt: string, model?: string): Promise<string> {
  const messages: Message[] = [{ role: 'user', content: prompt }];
  let text = '';
  const options = { maxTokens: 2048, temperature: 0.2, ...(model ? { modelOverride: model } : {}) };
  for await (const chunk of llm.complete(messages, [], options)) {
    if (chunk.type === 'text_delta') text += chunk.text;
  }
  return text;
}

// If the LLM picks a filename already used by an existing skill, suffix it with
// -2, -3, ... so a promotion never silently replaces a skill it did not draft.
async function pickAvailableName(
  proposed: string,
  dirs: readonly string[],
  storage: Storage,
): Promise<string> {
  const taken = new Set<string>();
  for (const dir of dirs) {
    for (const entry of await storage.list(dir)) {
      if (entry.endsWith('.md')) taken.add(entry);
    }
  }
  if (!taken.has(proposed)) return proposed;
  const base = proposed.replace(/\.md$/, '');
  for (let i = 2; i < 100; i++) {
    const candidate = `${base}-${i}.md`;
    if (!taken.has(candidate)) return candidate;
  }
  // Improbable, but bail safely with a timestamp suffix.
  return `${base}-${Date.now()}.md`;
}
