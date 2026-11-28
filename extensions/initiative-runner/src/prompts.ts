import type { ExplorationRow, FindingRow, IdeaRow } from '@ethosagent/types';
import type { InitiativeFile } from './config-schema';

/**
 * Run prompts. The owner's guidance goes here and nowhere else: it is run-only
 * advice (R8) and never reaches a chat prompt. Everything below is data the
 * runner read from the ledger or the validated YAML, rendered as plain text.
 */

export interface RunPromptInput {
  file: InitiativeFile;
  ideas: IdeaRow[];
  explorations: ExplorationRow[];
}

function sourceLabel(s: InitiativeFile['sources'][number]): string {
  return typeof s === 'string' ? s : `repo ${s.repo}`;
}

function header(file: InitiativeFile): string[] {
  const guidance = file.guidance
    .filter((g) => g.status === undefined || g.status === 'mapped')
    .map((g) => `- ${g.text}`);
  return [
    `You are running a read-only initiative window for "${file.title}" (${file.id}).`,
    `Outcome the owner wants: ${file.outcome}`,
    `Sources you may read: ${file.sources.map(sourceLabel).join(', ') || 'none'}.`,
    ...(file.exclude.length ? [`Never touch: ${file.exclude.join(', ')}.`] : []),
    ...(guidance.length
      ? ['Owner guidance (advice only, never permission to act):', ...guidance]
      : []),
    'You can only read and record. You cannot change files, send messages or create anything outside the ledger.',
  ];
}

export function surveyPrompt(i: RunPromptInput): string {
  const seeds = i.ideas.length
    ? i.ideas.map((d) => `- ${d.id}: ${d.text}`)
    : ['- (none; propose explorations from what the sources show)'];
  const open = i.explorations
    .filter((e) => e.state !== 'rejected')
    .map((e) => `- ${e.id} (${e.state}): ${e.question}`);
  return [
    ...header(i.file),
    '',
    'This is the survey window. Do these steps in order:',
    '1. Read each source once. Do not re-read a source you have already read.',
    '2. Check how the outcome stands today, using only what the sources show.',
    '3. For each seed idea below, call initiative_propose with kind "exploration", that idea_id, a question, estimate_usd and days.',
    '4. Add 2 or 3 explorations of your own with initiative_propose (no idea_id).',
    'Nothing runs until the owner approves a proposal. Keep the whole survey under $1.',
    '',
    'Seed ideas:',
    ...seeds,
    ...(open.length ? ['', 'Already on the ledger (do not propose duplicates):', ...open] : []),
    '',
    'End with a two-line summary of what you proposed.',
  ].join('\n');
}

export function windowPrompt(i: RunPromptInput & { exploration: ExplorationRow }): string {
  const e = i.exploration;
  return [
    ...header(i.file),
    '',
    `This is an exploration window for ${e.id}: ${e.question}`,
    `Budget left for this exploration: $${Math.max(0, e.budgetUsd - e.spentUsd).toFixed(2)}.`,
    '1. Read what you need from the sources to answer the question.',
    `2. Record each finding with initiative_note (exploration_id "${e.id}", a claim, the source_ref it came from, confidence 0 to 1).`,
    `3. When you can answer, or the budget is nearly spent, call initiative_brief for ${e.id}. Set partial: true if the question is not fully answered.`,
    '',
    'End with a two-line summary of what you found.',
  ].join('\n');
}

/**
 * The window a stalled exploration gets: it has used its budget or days, so it does not read
 * more. It turns what it already recorded into a partial brief. It never stops without one.
 */
export function briefWindowPrompt(
  i: RunPromptInput & { exploration: ExplorationRow; findings: FindingRow[] },
): string {
  const e = i.exploration;
  const found = i.findings.length
    ? i.findings.map((f) => `- ${f.id} (${f.confidence}): ${f.claim} [${f.sourceRef}]`)
    : ['- (no findings were recorded)'];
  return [
    ...header(i.file),
    '',
    `Exploration ${e.id} has used its budget or its days before the question was answered: ${e.question}`,
    'Do not read any more sources. Hand in what you have.',
    `Call initiative_brief for ${e.id} with partial: true, the options you can see, the evidence (finding ids below), the cost so far, the risk, and a recommendation.`,
    'Say plainly what is still unanswered, so the owner can choose to dig deeper.',
    '',
    'Findings so far:',
    ...found,
    '',
    'End with a two-line summary of what the brief says.',
  ].join('\n');
}

/**
 * The scan: look at the parent's sources for a topic that deserves its own initiative and
 * suggest it as a draft. A draft is only a suggestion; whether it ever becomes an initiative is
 * decided after the run (self-start setting, pool, limits), never here.
 */
export function scanPrompt(
  i: Pick<RunPromptInput, 'file' | 'explorations'> & { pending: string[] },
): string {
  const open = i.explorations
    .filter((e) => e.state !== 'rejected')
    .map((e) => `- ${e.id} (${e.state}): ${e.question}`);
  return [
    ...header(i.file),
    '',
    'This is the scan window. Do these steps in order:',
    '1. Read each source once.',
    '2. Look for a topic the owner has not asked about that clearly bears on the outcome and deserves its own initiative. Skip anything the ledger already covers.',
    '3. For at most two such topics, call initiative_propose with kind "new_initiative", a draft_yaml and a why.',
    '   draft_yaml is a YAML mapping with: title, outcome, sources (a subset of yours, never more), and optionally autonomy and budget.usd_per_day. Anything you leave out is inherited from this initiative. It can only be narrower than this initiative, never wider.',
    'Nothing is created by this call. The owner sees it as a suggestion unless they have let you start your own initiatives.',
    'If nothing deserves one, propose nothing. Keep the whole scan under $0.25.',
    ...(open.length ? ['', 'Already on the ledger:', ...open] : []),
    ...(i.pending.length ? ['', 'Already suggested (do not repeat):', ...i.pending] : []),
    '',
    'End with a one-line summary of what you suggested.',
  ].join('\n');
}
