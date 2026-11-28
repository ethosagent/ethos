import type {
  DecisionRow,
  DigestBrief,
  InitiativeDigest,
  InitiativeStore,
  QuestionRow,
  WindowRow,
} from '@ethosagent/types';

/** What the composer reads: the ledger's read side plus the three reads only the SQLite store has. */
export interface DigestSource {
  store: Pick<InitiativeStore, 'list' | 'get' | 'drafts'>;
  windows(initiativeId: string): WindowRow[];
  questions(initiativeId: string): QuestionRow[];
  decisionsSince(personalityId: string, sinceIso: string): DecisionRow[];
}

export interface DigestInput {
  personalityId: string;
  now: Date;
  /** Start of the period "what it did on its own" covers (the last digest, or a day back). */
  since: Date;
  /** `settings.selfStart`. Agent `new_initiative` drafts are suggestions only while it is off. */
  selfStart: boolean;
  /** `budget.usd_per_exploration` by initiative id: the "Dig deeper ($)" amount. */
  usdPerExploration?: ReadonlyMap<string, number>;
}

/** How far before `since` an approval still counts: a window can run days after its Gate 1 yes. */
const APPROVAL_LOOKBACK_MS = 7 * 86_400_000;

/** The text under `## <name>` in a brief body, up to the next heading. Empty when absent. */
function section(body: string, name: string): string {
  const lines = body.split('\n');
  const at = lines.findIndex((l) => l.trim().toLowerCase() === `## ${name}`.toLowerCase());
  if (at === -1) return '';
  const out: string[] = [];
  for (const l of lines.slice(at + 1)) {
    if (l.startsWith('## ')) break;
    out.push(l);
  }
  return out.join('\n').trim();
}

const bullets = (text: string): string[] =>
  text
    .split('\n')
    .map((l) => l.replace(/^\s*[-*]\s+/, '').trim())
    .filter((l) => l.length > 0);

/**
 * Pure: the digest model for one personality. No model call and no recipient; the runtime sends it
 * (`createInitiativeRuntime`, packages/wiring/src/initiative-runtime.ts) to `delivery.ownerChannel`.
 * It asks for a decision only where one is owed: `proposed` explorations (Gate 1), `briefed` ones
 * (Gate 2) and `self_started` initiatives. Pinned by digest.test.ts ('digest asks only what
 * needs the owner').
 */
export function composeDigest(src: DigestSource, input: DigestInput): InitiativeDigest {
  const { personalityId } = input;
  const sinceIso = input.since.toISOString();
  const rows = src.store.list({ personalityId });
  const mine = new Set(rows.map((r) => r.id));
  const approved = new Set(
    src
      .decisionsSince(
        personalityId,
        new Date(input.since.getTime() - APPROVAL_LOOKBACK_MS).toISOString(),
      )
      .flatMap((d) => (d.verdict === 'approve' ? [d.target] : [])),
  );

  const digest: InitiativeDigest = {
    personalityId,
    generatedAt: input.now.toISOString(),
    since: sinceIso,
    ownWork: { windows: 0, spentUsd: 0, explorations: [] },
    needsYes: [],
    agentInitiatives: [],
    briefs: [],
    questions: [],
    suggestions: [],
  };

  for (const row of rows) {
    const detail = src.store.get(row.id);
    const explorations = detail?.explorations ?? [];
    const questionOf = new Map(explorations.map((e) => [e.id, e.question]));
    const perExploration = new Map<string, { windows: number; spentUsd: number }>();
    for (const w of src.windows(row.id)) {
      if (w.started < sinceIso) continue;
      digest.ownWork.windows++;
      digest.ownWork.spentUsd += w.spentUsd;
      if (w.explorationId === null) continue;
      const cur = perExploration.get(w.explorationId) ?? { windows: 0, spentUsd: 0 };
      perExploration.set(w.explorationId, {
        windows: cur.windows + 1,
        spentUsd: cur.spentUsd + w.spentUsd,
      });
    }
    for (const [id, n] of perExploration) {
      digest.ownWork.explorations.push({
        id,
        question: questionOf.get(id) ?? '',
        auto: !approved.has(id),
        ...n,
      });
    }

    if (row.state === 'self_started') {
      digest.agentInitiatives.push({ id: row.id, parentId: row.parentId });
    }

    for (const e of explorations) {
      if (e.state === 'proposed') {
        digest.needsYes.push({
          explorationId: e.id,
          question: e.question,
          estimateUsd: e.estimateUsd,
        });
      }
      if (e.state !== 'briefed') continue;
      const briefs = (detail?.briefs ?? []).filter((b) => b.explorationId === e.id);
      const latest = briefs.reduce<(typeof briefs)[number] | undefined>(
        (a, b) => (!a || b.version > a.version ? b : a),
        undefined,
      );
      if (!latest) continue;
      const brief: DigestBrief = {
        explorationId: e.id,
        initiativeId: row.id,
        question: e.question,
        found: (detail?.findings ?? [])
          .filter((f) => f.explorationId === e.id)
          .map((f) => ({ id: f.id, claim: f.claim })),
        stillUnknown: bullets(section(latest.bodyMd, 'Still unknown')),
        options: bullets(section(latest.bodyMd, 'Options')),
        effort: section(latest.bodyMd, 'Cost'),
        risk: section(latest.bodyMd, 'Risk'),
        recommendation: section(latest.bodyMd, 'Recommendation'),
        recommendedOption: latest.recommendedOption,
        partial: latest.partial,
        digDeeperUsd: input.usdPerExploration?.get(row.id) ?? null,
      };
      digest.briefs.push(brief);
    }

    for (const q of src.questions(row.id)) {
      if (q.answer === null) {
        digest.questions.push({ id: q.id, initiativeId: row.id, text: q.text });
      }
    }
  }

  if (!input.selfStart) {
    for (const d of src.store.drafts('pending')) {
      if (mine.has(d.parentId)) {
        digest.suggestions.push({ draftId: d.id, parentId: d.parentId, why: d.why });
      }
    }
  }
  return digest;
}

/**
 * One brief as Markdown ("Copy as Markdown", and `ethos initiatives export`). The finding ids let
 * the owner trace each claim back to the ledger.
 */
export function renderBriefMarkdown(b: {
  question: string;
  bodyMd: string;
  recommendedOption: string | null;
  findings?: ReadonlyArray<{ id: string; claim: string }>;
}): string {
  const found = b.findings?.length
    ? `\n## Found\n${b.findings.map((f) => `- ${f.id}: ${f.claim}`).join('\n')}\n`
    : '';
  const rec = b.recommendedOption ? `\nRecommended option: ${b.recommendedOption}\n` : '';
  return `# ${b.question}\n\n${b.bodyMd.trimEnd()}\n${found}${rec}`;
}

const usd = (n: number): string => `$${n.toFixed(2)}`;

/**
 * The digest as Markdown: the text `Gateway.notifyTracked` carries (it is text-only), with the CLI
 * command for each action so a text-only channel can still act.
 */
export function renderDigestMarkdown(d: InitiativeDigest): string {
  const out: string[] = [`# Initiatives digest: ${d.personalityId}`];
  if (d.ownWork.windows > 0) {
    out.push(
      '',
      '## Did on its own',
      `${d.ownWork.windows} windows, ${usd(d.ownWork.spentUsd)} spent.`,
      ...d.ownWork.explorations.map(
        (e) => `- ${e.id}${e.auto ? ' (started automatically)' : ''}: ${e.question}`,
      ),
    );
  }
  if (d.needsYes.length > 0) {
    out.push(
      '',
      '## Needs a yes',
      ...d.needsYes.map(
        (p) =>
          `- ${p.explorationId}: ${p.question}${p.estimateUsd === null ? '' : ` (about ${usd(p.estimateUsd)})`}. Approve / Edit scope / Snooze 1w / Never: \`ethos initiatives approve ${p.explorationId}\``,
      ),
    );
  }
  if (d.agentInitiatives.length > 0) {
    out.push(
      '',
      '## Started by the agent',
      ...d.agentInitiatives.map(
        (i) => `- ${i.id}. Keep / Make it mine / Stop: \`ethos initiatives keep ${i.id}\``,
      ),
    );
  }
  if (d.briefs.length > 0) {
    out.push('', '## Briefs ready');
    for (const b of d.briefs) {
      out.push(
        `### ${b.explorationId}: ${b.question}${b.partial ? ' (partial)' : ''}`,
        ...(b.found.length ? ['Found:', ...b.found.map((f) => `- ${f.id}: ${f.claim}`)] : []),
        ...(b.stillUnknown.length
          ? ['Still unknown:', ...b.stillUnknown.map((u) => `- ${u}`)]
          : []),
        ...(b.options.length ? ['Options:', ...b.options.map((o) => `- ${o}`)] : []),
        ...(b.effort ? [`Effort: ${b.effort}`] : []),
        ...(b.risk ? [`Risk: ${b.risk}`] : []),
        ...(b.recommendation ? [`Recommendation: ${b.recommendation}`] : []),
        `Adopt / Dig deeper${b.digDeeperUsd === null ? '' : ` (${usd(b.digDeeperUsd)})`} / Park: \`ethos initiatives adopt ${b.explorationId}\``,
      );
    }
  }
  if (d.questions.length > 0) {
    out.push(
      '',
      '## Open questions',
      ...d.questions.map((q) => `- ${q.id} (${q.initiativeId}): ${q.text}`),
    );
  }
  if (d.suggestions.length > 0) {
    out.push(
      '',
      '## Agent suggestions',
      ...d.suggestions.map((s) => `- ${s.draftId} (from ${s.parentId}): ${s.why}`),
    );
  }
  return `${out.join('\n')}\n`;
}
