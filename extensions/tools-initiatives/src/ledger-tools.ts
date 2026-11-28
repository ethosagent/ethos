import type { InitiativeLedgerPort, Tool, ToolContext, ToolResult } from '@ethosagent/types';
import {
  argsRecord,
  failed,
  invalid,
  optString,
  refused,
  reqNumber,
  reqString,
  stringList,
} from './args';

type Args = Record<string, unknown>;

/**
 * A call that names another initiative is refused: the port is bound to one id.
 * Exploration and idea ids are checked separately by `ownedBy` (`port.ownerOf`);
 * the store does not constrain them, so this file is the enforcer.
 */
function wrongInitiative(a: Args, bound: string): ToolResult | null {
  const named = a.initiative_id;
  if (named === undefined || named === bound) return null;
  return refused(`this run is bound to initiative "${bound}"; it cannot act on another`);
}

/**
 * In an exploration window the run's note and brief tools write only to that window's
 * exploration. Enforced here; pinned by ledger-tools.test.ts ('bound to the window's exploration').
 */
function wrongExploration(id: string, bound: string | undefined): ToolResult | null {
  if (bound === undefined || id === bound) return null;
  return refused(`this window is bound to exploration "${bound}"; it cannot write to "${id}"`);
}

/** Refuses an exploration or idea id that is absent or owned by another initiative. */
function ownedBy(
  port: InitiativeLedgerPort,
  bound: string,
  kind: 'exploration' | 'idea',
  id: string,
): ToolResult | null {
  if (port.ownerOf(kind, id) === bound) return null;
  return refused(`${kind} "${id}" does not belong to initiative "${bound}"`);
}

function ledgerTool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
  bound: string,
  run: (a: Args) => ToolResult,
): Tool {
  return {
    name,
    description,
    toolset: 'initiative',
    maxResultChars: 6000,
    capabilities: {},
    schema: { type: 'object', properties, required },
    async execute(args: unknown, _ctx: ToolContext): Promise<ToolResult> {
      const a = argsRecord(args ?? {});
      if (failed(a)) return a;
      const other = wrongInitiative(a, bound);
      if (other) return other;
      return run(a);
    },
  };
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function briefBody(a: Args): string | ToolResult {
  const options = stringList(a, 'options');
  if (failed(options)) return options;
  const evidence = stringList(a, 'evidence');
  if (failed(evidence)) return evidence;
  const cost = reqString(a, 'cost');
  if (failed(cost)) return cost;
  const risk = reqString(a, 'risk');
  if (failed(risk)) return risk;
  const recommendation = reqString(a, 'recommendation');
  if (failed(recommendation)) return recommendation;
  return [
    '## Options',
    ...options.map((o) => `- ${o}`),
    '',
    '## Evidence',
    ...evidence.map((e) => `- ${e}`),
    '',
    `## Cost\n${cost}`,
    '',
    `## Risk\n${risk}`,
    '',
    `## Recommendation\n${recommendation}`,
  ].join('\n');
}

/**
 * Ledger tools bound to one initiative, written only through the narrow
 * `InitiativeLedgerPort`. None can write a file, a decision or the config:
 * `initiative_propose` with kind `new_initiative` stores a draft row that the
 * runner's post-run materialiser validates (InitiativeConfigService owns the YAML).
 * The recall tools (list/search/get) are `createInitiativeRecallTools`.
 */
export function createInitiativeLedgerTools(
  port: InitiativeLedgerPort,
  initiativeId: string,
  /** The exploration this window works on; `initiative_note` and `initiative_brief` refuse any other. */
  boundExploration?: string,
): Tool[] {
  const idProp = {
    initiative_id: { type: 'string', description: "Optional; must equal this run's initiative." },
  };

  const propose = ledgerTool(
    'initiative_propose',
    'Propose an exploration for the owner to approve (question, estimate_usd, days), or kind "new_initiative" with draft_yaml and why to suggest a new initiative. Nothing runs until the owner approves.',
    {
      ...idProp,
      kind: { type: 'string', enum: ['exploration', 'new_initiative'] },
      question: { type: 'string' },
      estimate_usd: { type: 'number' },
      days: { type: 'number' },
      idea_id: { type: 'string' },
      draft_yaml: { type: 'string' },
      why: { type: 'string' },
    },
    [],
    initiativeId,
    (a) => {
      if (a.kind === 'new_initiative') {
        const draftYaml = reqString(a, 'draft_yaml');
        if (failed(draftYaml)) return draftYaml;
        const why = reqString(a, 'why');
        if (failed(why)) return why;
        const { draftId } = port.proposeInitiativeDraft({ parentId: initiativeId, draftYaml, why });
        return { ok: true, value: `Draft ${draftId} proposed for the owner to review.` };
      }
      if (a.kind !== undefined && a.kind !== 'exploration') {
        return invalid('kind must be "exploration" or "new_initiative"', 'kind');
      }
      const question = reqString(a, 'question');
      if (failed(question)) return question;
      const estimateUsd = reqNumber(a, 'estimate_usd');
      if (failed(estimateUsd)) return estimateUsd;
      // Enforced here: the store clamps the budget but a zero or NaN estimate would still pass
      // the autonomy comparison (extensions/initiative-runner/src/autonomy.ts decideAutonomy).
      if (!Number.isFinite(estimateUsd) || estimateUsd <= 0) {
        return invalid('estimate_usd must be a positive number', 'estimate_usd');
      }
      const days = reqNumber(a, 'days');
      if (failed(days)) return days;
      if (!Number.isFinite(days) || days <= 0) {
        return invalid('days must be a positive number', 'days');
      }
      const ideaId = optString(a, 'idea_id');
      if (failed(ideaId)) return ideaId;
      if (ideaId !== undefined) {
        const foreign = ownedBy(port, initiativeId, 'idea', ideaId);
        if (foreign) return foreign;
      }
      const row = port.propose({
        initiativeId,
        ideaId: ideaId ?? null,
        question,
        estimateUsd,
        days,
      });
      return {
        ok: true,
        value: `Exploration ${row.id} proposed (${row.state}); awaiting approval.`,
      };
    },
  );

  const note = ledgerTool(
    'initiative_note',
    'Record one finding. source_ref (a URL, file path or session id the claim came from) is required.',
    {
      ...idProp,
      exploration_id: { type: 'string' },
      claim: { type: 'string' },
      source_ref: { type: 'string' },
      confidence: { type: 'number', description: '0 to 1' },
    },
    ['exploration_id', 'claim', 'source_ref', 'confidence'],
    initiativeId,
    (a) => {
      const explorationId = reqString(a, 'exploration_id');
      if (failed(explorationId)) return explorationId;
      const elsewhere = wrongExploration(explorationId, boundExploration);
      if (elsewhere) return elsewhere;
      const claim = reqString(a, 'claim');
      if (failed(claim)) return claim;
      const sourceRef = reqString(a, 'source_ref');
      if (failed(sourceRef)) return sourceRef;
      const confidence = reqNumber(a, 'confidence');
      if (failed(confidence)) return confidence;
      if (confidence > 1) return invalid('confidence must be between 0 and 1', 'confidence');
      const foreign = ownedBy(port, initiativeId, 'exploration', explorationId);
      if (foreign) return foreign;
      const f = port.addFinding({ explorationId, claim, sourceRef, confidence });
      return { ok: true, value: `Finding ${f.id} recorded.` };
    },
  );

  const brief = ledgerTool(
    'initiative_brief',
    'Submit the brief for an exploration: options, evidence (finding ids), cost, risk, recommendation. Set partial:true when the window ended before the question was answered.',
    {
      ...idProp,
      exploration_id: { type: 'string' },
      options: { type: 'array', items: { type: 'string' } },
      evidence: { type: 'array', items: { type: 'string' } },
      cost: { type: 'string' },
      risk: { type: 'string' },
      recommendation: { type: 'string' },
      partial: { type: 'boolean' },
    },
    ['exploration_id', 'options', 'evidence', 'cost', 'risk', 'recommendation'],
    initiativeId,
    (a) => {
      const explorationId = reqString(a, 'exploration_id');
      if (failed(explorationId)) return explorationId;
      const elsewhere = wrongExploration(explorationId, boundExploration);
      if (elsewhere) return elsewhere;
      if (a.partial !== undefined && typeof a.partial !== 'boolean') {
        return invalid('partial must be a boolean', 'partial');
      }
      const body = briefBody(a);
      if (typeof body !== 'string') return body;
      const recommendation = reqString(a, 'recommendation');
      if (failed(recommendation)) return recommendation;
      const foreign = ownedBy(port, initiativeId, 'exploration', explorationId);
      if (foreign) return foreign;
      const row = port.submitBrief({
        explorationId,
        bodyMd: body,
        recommendedOption: recommendation,
        partial: a.partial === true,
      });
      return { ok: true, value: `Brief ${row.id} (v${row.version}) submitted.` };
    },
  );

  const ideas = ledgerTool(
    'initiative_ideas',
    "List this initiative's ideas.",
    { ...idProp },
    [],
    initiativeId,
    () => {
      const rows = port.ideas(initiativeId);
      if (rows.length === 0) return { ok: true, value: 'No ideas yet.' };
      return {
        ok: true,
        value: rows.map((i) => `[${i.id}] (${i.origin}) ${i.text}`).join('\n'),
      };
    },
  );

  const budget = ledgerTool(
    'initiative_budget',
    "Today's spend, cap and open explorations for this initiative.",
    { ...idProp },
    [],
    initiativeId,
    () => {
      const b = port.budget(initiativeId, today());
      return {
        ok: true,
        value: `Spent USD ${b.spentUsd} of ${b.capUsd} today; ${b.explorationsOpen} exploration(s) open.`,
      };
    },
  );

  return [propose, note, brief, ideas, budget];
}

/** Run-local `clarify`: records a question for the digest instead of asking a live user. */
export function createRunClarifyTool(port: InitiativeLedgerPort, initiativeId: string): Tool {
  return ledgerTool(
    'clarify',
    'Ask the owner a question. It is shown in the next digest; do not wait for the answer.',
    {
      question: { type: 'string' },
      exploration_id: { type: 'string' },
      initiative_id: { type: 'string' },
    },
    ['question'],
    initiativeId,
    (a) => {
      const text = reqString(a, 'question');
      if (failed(text)) return text;
      const explorationId = optString(a, 'exploration_id');
      if (failed(explorationId)) return explorationId;
      if (explorationId !== undefined) {
        const foreign = ownedBy(port, initiativeId, 'exploration', explorationId);
        if (foreign) return foreign;
      }
      const id = port.addQuestion({ initiativeId, explorationId: explorationId ?? null, text });
      return { ok: true, value: `Question ${id} recorded for the digest.` };
    },
  );
}
